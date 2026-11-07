import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { z, ZodError } from "zod";
import type { AppConfig } from "./config.js";
import { AuthError, createAuthenticator, resolveOrg, type Authenticator, type AuthUser, type OrgContext } from "./auth.js";
import { canContact, maskRecipient, recipientFor, SMS_MAX, toCardDto, withSmsOptOut } from "./domain.js";
import { dealRoutes } from "./deals/routes.js";
import { recommend } from "./recommend.js";
import { optOutRoutes, REOPTIN_PATH, RESUBSCRIBE_PATH, TWILIO_WEBHOOK_PREFIX, UNSUBSCRIBE_PATH } from "./optout/routes.js";
import { unsubscribeLink } from "./optout/unsubscribe.js";
import multipart from "@fastify/multipart";
import { INBOUND_EMAIL_PATH, replyRoutes, replyToAddress } from "./replies/routes.js";
import { processDelivery } from "./delivery.js";
import { loggerOptions } from "./logger.js";
import type { SuggestionProvider } from "./providers/ai.js";
import type { MessageProvider } from "./providers/messaging.js";
import { StoreError, type OutreachStore } from "./store/types.js";
import { costUsd, listModels, modelInfo, PRICE_TABLE_VERSION, RULES_MODEL } from "./ai/models.js";
import { costReport } from "./metrics/cost.js";
import { DEFAULT_ATTRIBUTION_DAYS, performanceReport } from "./metrics/performance.js";
import { ConsoleInviteMailer, SupabaseInviteMailer, type InviteMailer } from "./team/mailer.js";
import { INVITE_ACCEPT_PATH, INVITE_PREVIEW_PATH, teamRoutes } from "./team/routes.js";
import type { Actor } from "./types.js";

declare module "fastify" {
  interface FastifyRequest {
    auth: { user: AuthUser; org: OrgContext | null } | null;
  }
}

export type AppDeps = {
  config: AppConfig;
  store: OutreachStore;
  suggestions: SuggestionProvider;
  messenger: MessageProvider;
  /** Defaults to one built from config (Supabase JWT or demo). Tests inject their own. */
  authenticator?: Authenticator;
  /** Present only in DELIVERY_MODE=queue. */
  enqueueDelivery?: (deliveryId: string) => Promise<void>;
  /** Sends team invitations. Defaults from config (console in dev, Supabase Auth in production). */
  inviteMailer?: InviteMailer;
  /** false disables logging (tests). */
  logger?: boolean;
};

const idParams = z.object({ id: z.string().min(1).max(100) });
const channel = z.enum(["sms", "email"]);
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const PUBLIC_PATHS = new Set(["/health", "/health/live", "/health/ready"]);
/** Routes that need a user but not an org (e.g. to list orgs before choosing one). */
const NO_ORG_PATHS = new Set(["/api/me", INVITE_ACCEPT_PATH]);
/** API routes reachable without a session (still rate limited per IP). */
const ANON_PATHS = new Set([INVITE_PREVIEW_PATH, UNSUBSCRIBE_PATH, RESUBSCRIBE_PATH, REOPTIN_PATH]);
const isAnon = (path: string) => ANON_PATHS.has(path) || path === INBOUND_EMAIL_PATH || path.startsWith(TWILIO_WEBHOOK_PREFIX);

/** Uniform error body: { error, code, requestId, details? }. */
function sendError(reply: FastifyReply, status: number, code: string, error: string, details?: string[]) {
  return reply.code(status).send({ error, code, requestId: reply.request.id, ...(details ? { details } : {}) });
}

function actorOf(req: { auth: { user: AuthUser; org: OrgContext | null } | null }): Actor {
  if (!req.auth?.org) throw new AuthError(401, "unauthenticated", "Authentication required");
  return { userId: req.auth.user.id, orgId: req.auth.org.orgId };
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, store, suggestions, messenger } = deps;
  const authenticator = deps.authenticator ?? createAuthenticator(config);
  if (config.NODE_ENV === "production" && authenticator.mode !== "supabase") {
    throw new Error("Refusing to start: demo authentication in production");
  }

  const app = Fastify({
    logger: deps.logger === false ? false : loggerOptions(config),
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 64 * 1024,
    requestIdHeader: false,
    genReqId: req => {
      const incoming = req.headers["x-request-id"];
      return typeof incoming === "string" && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
    }
  });

  app.addHook("onRequest", async (request, reply) => { reply.header("x-request-id", request.id); });

  await app.register(helmet, {
    // JSON API: lock everything down; the frontend is served separately with its own CSP.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: "same-site" },
    hsts: config.NODE_ENV === "production" ? { maxAge: 31536000, includeSubDomains: true } : false
  });
  const anyOrigin = config.CORS_ORIGIN.includes("*");
  await app.register(cors, {
    origin: anyOrigin ? true : config.CORS_ORIGIN,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "X-Org-Id", "X-Request-Id"],
    exposedHeaders: ["X-Request-Id", "Retry-After"],
    maxAge: 600
  });

  // Authenticate every /api request. Identity comes only from the verified token; org only from membership.
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0];
    if (PUBLIC_PATHS.has(path) || isAnon(path) || request.method === "OPTIONS") return;
    try {
      const user = await authenticator.authenticate(request.headers.authorization);
      // Approval gate: only people on a Team list (member, or matching pending invite → auto-joined) get any API.
      // The invite-accept endpoint stays open so an invite link can still make someone a member.
      let memberships = await store.listMemberships(user.id);
      if (path !== INVITE_ACCEPT_PATH) {
        if (!memberships.length && (await store.claimPendingInvitations(user))) memberships = await store.listMemberships(user.id);
        if (!memberships.length) {
          return sendError(reply, 403, "not_approved",
            `${user.email ?? "This account"} has not been approved for this application. If this is in error, please contact your administrator.`);
        }
      }
      let org: OrgContext | null = null;
      if (!NO_ORG_PATHS.has(path)) {
        const requested = request.headers["x-org-id"];
        org = resolveOrg(memberships, typeof requested === "string" ? requested : undefined);
      }
      request.auth = { user, org };
    } catch (e) {
      if (e instanceof AuthError) {
        if (e.status === 401) reply.header("www-authenticate", `Bearer error="${e.code === "unauthenticated" ? "invalid_request" : "invalid_token"}"`);
        return sendError(reply, e.status, e.code, e.message);
      }
      throw e;
    }
  });

  // Rate limit after auth so limits are per user (falls back to IP). Health probes are exempt.
  await app.register(rateLimit, {
    hook: "preHandler",
    max: config.RATE_LIMIT_PER_MINUTE,
    timeWindow: "1 minute",
    allowList: req => PUBLIC_PATHS.has(req.url.split("?")[0]),
    keyGenerator: req => req.auth?.user.id ?? req.ip,
    errorResponseBuilder: (req, ctx) => ({
      statusCode: 429, error: "Too many requests", code: "rate_limited", requestId: req.id,
      details: [`Retry in ${Math.ceil(ctx.ttl / 1000)}s`]
    })
  });

  app.setErrorHandler((error: any, request, reply) => {
    if (error instanceof ZodError) {
      return sendError(reply, 400, "invalid_request", "Invalid request", error.issues.map(i => `${i.path.join(".") || "body"}: ${i.message}`));
    }
    if (error instanceof AuthError) return sendError(reply, error.status, error.code, error.message);
    if (error instanceof StoreError) {
      const status = ({ not_found: 404, conflict: 409, suppressed: 422, forbidden: 403, gone: 410, rate_limited: 429 } as const)[error.code];
      return sendError(reply, status, error.reason ?? error.code, error.message);
    }
    const status: number = error.statusCode ?? 500;
    if (status === 429) return reply.code(429).send(error);
    if (status >= 500) {
      request.log.error({ err: error }, "unhandled error");
      return sendError(reply, status, "internal", "Internal server error");
    }
    return sendError(reply, status, error.code === "FST_ERR_CTP_BODY_TOO_LARGE" ? "payload_too_large" : "bad_request", error.message);
  });
  app.setNotFoundHandler((request, reply) => sendError(reply, 404, "not_found", "Route not found"));

  // ── Health ──────────────────────────────────────────────────────────
  app.get("/health/live", async () => ({ ok: true }));
  const ready = async (_req: unknown, reply: FastifyReply) => {
    try {
      await store.ping();
      return { ok: true, store: store.kind, auth: authenticator.mode, delivery: config.DELIVERY_MODE, ai: suggestions.name };
    } catch {
      return reply.code(503).send({ ok: false, error: "Database unavailable" });
    }
  };
  app.get("/health/ready", ready);
  app.get("/health", ready);

  // ── Session ─────────────────────────────────────────────────────────
  app.get("/api/me", async request => {
    const user = request.auth!.user;
    return { user: { id: user.id, email: user.email }, memberships: await store.listMemberships(user.id), authMode: authenticator.mode, dataStore: config.DATA_STORE };
  });

  // ── Outreach ────────────────────────────────────────────────────────
  app.get("/api/outreach/queue", async request => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(request.query);
    const { items, total } = await store.listQueue(actorOf(request), limit);
    return { items: items.map(o => toCardDto(o)), total };
  });

  app.get("/api/outreach/:id", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const opp = await store.getOpportunity(actorOf(request), id);
    if (!opp) return sendError(reply, 404, "not_found", "Opportunity not found");
    return toCardDto(opp);
  });

  /** AI suggestion (title, reasoning, message) for a channel. */
  app.post("/api/outreach/:id/suggestion", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = z.object({ channel }).strict().parse(request.body ?? {});
    const actor = actorOf(request);
    const opp = await store.getOpportunity(actor, id);
    if (!opp) return sendError(reply, 404, "not_found", "Opportunity not found");
    if (!canContact(opp.customer, body.channel)) {
      return sendError(reply, 422, "not_contactable", `Customer cannot be contacted by ${body.channel}`);
    }
    const [deals, catalog, settings] = await Promise.all([store.listDeals(actor), store.listCatalog(actor), store.getSettings(actor)]);
    const businessName = settings.storeName ?? request.auth!.org!.businessName ?? config.BUSINESS_NAME;
    const recommendation = recommend(opp.customer, deals, { catalog, maxDiscountPercent: settings.maxDiscountPercent });
    // The standing fallback offer never exceeds the org's discount cap.
    const offer = opp.offer && { ...opp.offer, discountPercent: Math.min(opp.offer.discountPercent, settings.maxDiscountPercent) };
    const suggestion = await suggestions.suggest({
      opportunity: { ...opp, offer: offer && offer.discountPercent > 0 ? offer : null }, channel: body.channel, businessName, recommendation,
      signatures: { sms: settings.smsSignature, email: settings.emailSignature }, model: settings.aiModel
    });
    await store.saveSuggestion(actor, id, suggestion);
    // Cost metrics: one row per suggestion call (rules = $0). Never block the suggestion on metrics.
    const info = modelInfo(suggestion.model);
    await store.recordAiUsage(actor, {
      opportunityId: id, model: suggestion.model, provider: info?.provider ?? "rules",
      inputTokens: suggestion.usage?.inputTokens ?? 0, outputTokens: suggestion.usage?.outputTokens ?? 0,
      costUsd: suggestion.usage ? costUsd(suggestion.model, suggestion.usage.inputTokens, suggestion.usage.outputTokens) : 0,
      priceVersion: PRICE_TABLE_VERSION, dealId: suggestion.deal?.id ?? null, dealTitle: suggestion.deal?.title ?? null
    }).catch(e => request.log.warn({ err: e }, "failed to record AI usage"));
    const { usage: _u, ...publicSuggestion } = suggestion;
    return { suggestion: publicSuggestion };
  });

  app.post("/api/outreach/:id/skip", async request => {
    const { id } = idParams.parse(request.params);
    await store.skip(actorOf(request), id);
    return { ok: true, status: "skipped" };
  });

  /** Record that the customer asked not to be contacted. Enforced on every later send (app + DB trigger). */
  app.post("/api/outreach/:id/opt-out", async request => {
    const { id } = idParams.parse(request.params);
    const body = z.object({
      channel: z.enum(["sms", "email", "all"]).default("all"),
      reason: z.enum(["opt_out", "bounce", "complaint", "manual"]).default("opt_out")
    }).strict().parse(request.body ?? {});
    const channels = body.channel === "all" ? (["sms", "email"] as const) : [body.channel];
    await store.optOut(actorOf(request), id, [...channels], body.reason, { requestId: request.id });
    return { ok: true, status: "suppressed", channels };
  });

  /** Send the (possibly edited) message. Idempotent per idempotencyKey. */
  app.post("/api/outreach/:id/send", {
    config: { rateLimit: { max: config.SEND_RATE_LIMIT_PER_MINUTE, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = z.object({
      channel,
      message: z.string().trim().min(1).max(5000),
      subject: z.string().trim().max(200).nullish(),
      idempotencyKey: z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/, "must be URL-safe")
    }).strict().parse(request.body ?? {});
    // Compliance: every marketing SMS carries opt-out instructions, even if staff edited them out.
    const message = body.channel === "sms" ? withSmsOptOut(body.message) : body.message;
    if (body.channel === "sms" && message.length > SMS_MAX) {
      return sendError(reply, 400, "invalid_request", `SMS must be ${SMS_MAX} characters or fewer`);
    }
    const actor = actorOf(request);
    const opp = await store.getOpportunity(actor, id);
    if (!opp) return sendError(reply, 404, "not_found", "Opportunity not found");
    if (opp.customer.suppressed.includes(body.channel)) {
      return sendError(reply, 422, "suppressed", "Recipient has opted out of this channel");
    }
    if (!canContact(opp.customer, body.channel)) {
      return sendError(reply, 422, "not_contactable", `Customer cannot be contacted by ${body.channel}`);
    }
    const businessName = (await store.getSettings(actor)).storeName ?? request.auth!.org!.businessName ?? config.BUSINESS_NAME;
    const subject = body.channel === "email" ? (body.subject || `A note from ${businessName}`) : null;
    const { delivery, duplicate } = await store.createDelivery(actor, id, {
      channel: body.channel, recipient: recipientFor(opp.customer, body.channel)!,
      message, subject, idempotencyKey: body.idempotencyKey
    });
    if (duplicate) return reply.code(200).send({ deliveryId: delivery.id, status: delivery.status, duplicate: true });
    await recordSendMetrics(request, actor, id, opp.customer.id, body.channel, delivery.id)
      .catch(e => request.log.warn({ err: e }, "failed to record send metrics"));

    if (deps.enqueueDelivery) {
      await deps.enqueueDelivery(delivery.id);
      return reply.code(202).send({ deliveryId: delivery.id, status: "queued" });
    }
    try {
      const done = await processDelivery(store, messenger, delivery.id, {
        unsubscribe: id => unsubscribeLink(config.PUBLIC_API_URL, config.UNSUBSCRIBE_SIGNING_SECRET, id),
        replyTo: token => replyToAddress(config, token)
      });
      return reply.code(200).send({ deliveryId: done.id, status: done.status });
    } catch (e) {
      request.log.error({ err: e, deliveryId: delivery.id }, "delivery failed");
      return reply.code(502).send({ deliveryId: delivery.id, status: "failed", error: "Message provider failed to send", code: "provider_error", requestId: request.id });
    }
  });

  app.get("/api/outreach/:id/deliveries", async request => {
    const { id } = idParams.parse(request.params);
    const deliveries = await store.listDeliveries(actorOf(request), id);
    // The browser never needs raw contact details or message bodies of other staff; mask the recipient.
    return { deliveries: deliveries.map(({ recipient, orgId: _o, ...d }) => ({ ...d, recipient: maskRecipient(recipient) })) };
  });

  app.get("/api/metrics", async request => store.metrics(actorOf(request)));

  /** Send ledger row (who sent, which model/deal) for cost + performance metrics. */
  async function recordSendMetrics(request: FastifyRequest, actor: Actor, oppId: string, customerId: string, ch: "sms" | "email", deliveryId: string) {
    const used = await store.markAiUsageSent(actor, oppId, ch);
    const deal = used?.dealId ? (await store.listDeals(actor)).find(d => d.id === used.dealId) : undefined;
    const email = request.auth?.user.email ?? null;
    await store.recordSend(actor, {
      deliveryId, userLabel: email ? email.split("@")[0] : "Team member", customerId, channel: ch,
      dealId: used?.dealId ?? null, dealTitle: used?.dealTitle ?? null, dealCategories: deal?.categories ?? [], dealProductIds: deal?.productIds ?? [],
      model: used?.model ?? RULES_MODEL
    });
  }

  /** Performance metrics (all members; per-person revenue of others is owner/admin only). */
  app.get("/api/metrics/performance", async request => {
    const actor = actorOf(request);
    const q = z.object({ days: z.coerce.number().int().min(1).max(90).default(DEFAULT_ATTRIBUTION_DAYS) }).parse(request.query);
    const now = new Date();
    const since = new Date(Math.min(new Date(now.getFullYear(), 0, 1).getTime(), new Date(now.getFullYear(), now.getMonth() - 6, 1).getTime()) - q.days * 86_400_000).toISOString();
    const [sends, purchases] = await Promise.all([store.listSends(actor, since), store.listPurchaseRows(actor, since)]);
    const role = request.auth?.org?.role;
    return performanceReport(sends, purchases, { now, days: q.days, viewerId: actor.userId, canSeeAll: role === "owner" || role === "admin" });
  });

  /** Cost metrics (owners/admins): YTD AI spend per month and model. */
  app.get("/api/metrics/costs", async request => {
    const actor = actorOf(request);
    const now = new Date();
    const since = new Date(now.getFullYear(), 0, 1).toISOString();
    const [usage, sends] = await Promise.all([store.listAiUsage(actor, since), store.listSends(actor, since)]);
    return costReport(usage, sends, now);
  });

  // ── Promotions & settings ───────────────────────────────────────────
  await dealRoutes(app, { store, actorOf });
  /** Model picker options: allowlist, cost hints, and whether each provider is configured on this server. */
  app.get("/api/ai/models", async request => {
    const settings = await store.getSettings(actorOf(request));
    const models = listModels(config);
    const selected = models.find(m => m.id === settings.aiModel);
    return { models, selected: settings.aiModel, effective: selected?.available ? settings.aiModel : RULES_MODEL, priceTableVersion: PRICE_TABLE_VERSION };
  });

  await optOutRoutes(app, { config, store, actorOf, messenger, sendError });
  // Inbound email webhooks may be multipart (SendGrid Inbound Parse). Attachments are discarded.
  await app.register(multipart, {
    attachFieldsToBody: "keyValues", limits: { fields: 50, fieldSize: 1024 * 1024, files: 20, fileSize: 10 * 1024 * 1024 },
    onFile: async (part: any) => { part.file.resume(); }
  } as any);
  await replyRoutes(app, { config, store, messenger, actorOf, sendError });

  // ── Team ────────────────────────────────────────────────────────────
  const inviteMailer = deps.inviteMailer ?? (config.INVITE_MAILER === "supabase"
    ? new SupabaseInviteMailer({ supabaseUrl: config.SUPABASE_URL!, serviceRoleKey: config.SUPABASE_SERVICE_ROLE_KEY! })
    : new ConsoleInviteMailer((line, meta) => app.log.info(meta, line)));
  await teamRoutes(app, { config, store, mailer: inviteMailer, actorOf, sendError });

  /** Development helper so the demo deck can be replayed. Config forbids it in production. */
  if (config.ENABLE_DEMO_RESET && config.NODE_ENV !== "production") {
    app.post("/api/dev/reset", async request => {
      await store.reset(actorOf(request));
      return { ok: true };
    });
  }

  return app;
}
