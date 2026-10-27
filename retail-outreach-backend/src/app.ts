import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { z, ZodError } from "zod";
import type { AppConfig } from "./config.js";
import { AuthError, createAuthenticator, resolveOrg, type Authenticator, type AuthUser, type OrgContext } from "./auth.js";
import { canContact, maskRecipient, recipientFor, toCardDto } from "./domain.js";
import { processDelivery } from "./delivery.js";
import { loggerOptions } from "./logger.js";
import type { SuggestionProvider } from "./providers/ai.js";
import type { MessageProvider } from "./providers/messaging.js";
import { StoreError, type OutreachStore } from "./store/types.js";
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

const SMS_MAX = 480; // ~3 SMS segments
const idParams = z.object({ id: z.string().min(1).max(100) });
const channel = z.enum(["sms", "email"]);
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const PUBLIC_PATHS = new Set(["/health", "/health/live", "/health/ready"]);
/** Routes that need a user but not an org (e.g. to list orgs before choosing one). */
const NO_ORG_PATHS = new Set(["/api/me", INVITE_ACCEPT_PATH]);
/** API routes reachable without a session (still rate limited per IP). */
const ANON_PATHS = new Set([INVITE_PREVIEW_PATH]);

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
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "X-Org-Id", "X-Request-Id"],
    exposedHeaders: ["X-Request-Id", "Retry-After"],
    maxAge: 600
  });

  // Authenticate every /api request. Identity comes only from the verified token; org only from membership.
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0];
    if (PUBLIC_PATHS.has(path) || ANON_PATHS.has(path) || request.method === "OPTIONS") return;
    try {
      const user = await authenticator.authenticate(request.headers.authorization);
      let org: OrgContext | null = null;
      if (!NO_ORG_PATHS.has(path)) {
        const requested = request.headers["x-org-id"];
        org = resolveOrg(await store.listMemberships(user.id), typeof requested === "string" ? requested : undefined);
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
      const status = ({ not_found: 404, conflict: 409, suppressed: 422, forbidden: 403, gone: 410 } as const)[error.code];
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
    return { user: { id: user.id, email: user.email }, memberships: await store.listMemberships(user.id), authMode: authenticator.mode };
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
    const businessName = request.auth!.org!.businessName ?? config.BUSINESS_NAME;
    const suggestion = await suggestions.suggest({ opportunity: opp, channel: body.channel, businessName });
    await store.saveSuggestion(actor, id, suggestion);
    return { suggestion };
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
    await store.optOut(actorOf(request), id, [...channels], body.reason);
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
    if (body.channel === "sms" && body.message.length > SMS_MAX) {
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
    const businessName = request.auth!.org!.businessName ?? config.BUSINESS_NAME;
    const subject = body.channel === "email" ? (body.subject || `A note from ${businessName}`) : null;
    const { delivery, duplicate } = await store.createDelivery(actor, id, {
      channel: body.channel, recipient: recipientFor(opp.customer, body.channel)!,
      message: body.message, subject, idempotencyKey: body.idempotencyKey
    });
    if (duplicate) return reply.code(200).send({ deliveryId: delivery.id, status: delivery.status, duplicate: true });

    if (deps.enqueueDelivery) {
      await deps.enqueueDelivery(delivery.id);
      return reply.code(202).send({ deliveryId: delivery.id, status: "queued" });
    }
    try {
      const done = await processDelivery(store, messenger, delivery.id);
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
