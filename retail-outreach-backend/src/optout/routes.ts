import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { OutreachStore } from "../store/types.js";
import type { Actor } from "../types.js";
import type { MessageProvider } from "../providers/messaging.js";
import { keywordReply, parseKeyword, reoptInSms, twiml, verifyTwilioSignature } from "./twilio.js";
import { purposeToken, verifyPurposeToken, verifyUnsubscribeToken } from "./unsubscribe.js";

export const TWILIO_WEBHOOK_PREFIX = "/webhooks/twilio/sms/";
export const UNSUBSCRIBE_PATH = "/unsubscribe";
export const RESUBSCRIBE_PATH = "/resubscribe";
export const REOPTIN_PATH = "/reopt-in";

type Deps = {
  config: AppConfig; store: OutreachStore; actorOf: (req: any) => Actor; messenger: MessageProvider;
  sendError: (reply: FastifyReply, status: number, code: string, error: string) => FastifyReply;
};

const esc = (s: string) => s.replace(/[<>&'"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&#39;", '"': "&quot;" })[c]!);
function page(reply: FastifyReply, status: number, title: string, body: string) {
  return reply.code(status)
    .header("content-type", "text/html; charset=utf-8")
    .header("cache-control", "no-store")
    .header("referrer-policy", "no-referrer")
    .header("x-robots-tag", "noindex")
    .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'")
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>body{font-family:system-ui,sans-serif;background:#f5f7fa;color:#1d2939;display:grid;place-items:center;min-height:100vh;margin:0}
main{background:#fff;border-radius:16px;padding:32px;max-width:420px;box-shadow:0 4px 24px #0001;text-align:center}
button{background:#d92d20;}button.ok{background:#11966b;}button{color:#fff;border:0;border-radius:999px;padding:12px 24px;font-size:16px;cursor:pointer}</style></head>
<body><main><h1>${esc(title)}</h1>${body}</main></body></html>`);
}

/** Opt-out list API, Twilio inbound SMS webhook, and the public email unsubscribe page. */
export async function optOutRoutes(app: FastifyInstance, { config, store, actorOf, messenger, sendError }: Deps) {
  // Twilio and RFC 8058 one-click POSTs are form-encoded.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 16 * 1024 },
    (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))));

  // ── Opt-out list (members) ──
  app.get("/api/opt-outs", async request => {
    const q = z.object({
      channel: z.enum(["sms", "email"]).optional(),
      q: z.string().trim().max(100).optional(),
      page: z.coerce.number().int().min(1).max(10_000).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(25)
    }).parse(request.query);
    const { items, total } = await store.listOptOuts(actorOf(request), {
      channel: q.channel, search: q.q || undefined, limit: q.pageSize, offset: (q.page - 1) * q.pageSize
    });
    return { items, total, page: q.page, pageSize: q.pageSize };
  });

  // ── Consent history + re-opt-in requests ──
  const optOutId = z.object({ id: z.string().min(1).max(100) });
  app.get("/api/opt-outs/:id/history", async request => {
    const { id } = optOutId.parse(request.params);
    return { events: await store.listConsentEvents(actorOf(request), id) };
  });

  /**
   * Owner/admin: ask an opted-out customer, once, whether they want to hear from us again.
   * Email: a confirmation email whose signed link resubscribes on click. SMS: one text asking them to reply START
   * (refused unless ALLOW_SMS_REOPTIN_REQUEST=true). One per customer+channel per 30 days; never while one is pending.
   * Nothing here lifts the opt-out: only the customer's own action does.
   */
  app.post("/api/opt-outs/:id/reopt-in", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const { id } = optOutId.parse(request.params);
    const actor = actorOf(request);
    const { request: req, recipient, customerFirstName } = await store.createReoptInRequest(actor, id,
      { actorId: actor.userId, requestId: request.id }, { allowSms: config.ALLOW_SMS_REOPTIN_REQUEST });
    const storeName = (await store.orgDisplayName(actor.orgId)) ?? config.BUSINESS_NAME;
    try {
      if (req.channel === "email") {
        const url = `${config.PUBLIC_API_URL}${REOPTIN_PATH}?t=${encodeURIComponent(purposeToken(config.UNSUBSCRIBE_SIGNING_SECRET, "reoptin", req.id))}`;
        await messenger.send({
          channel: "email", recipient, orgId: actor.orgId, subject: `${storeName}: would you like to hear from us again?`,
          message: `Hi${customerFirstName ? ` ${customerFirstName}` : ""},\n\nYou unsubscribed from ${storeName} emails. If you'd like to get our deals again, confirm here:\n${url}\n\nIf you don't click, you stay unsubscribed and we won't ask again for at least 30 days.`
        });
      } else {
        await messenger.send({ channel: "sms", recipient, orgId: actor.orgId, message: reoptInSms(storeName, customerFirstName) });
      }
    } catch (e) {
      request.log.error({ err: e }, "re-opt-in request send failed");
      await store.cancelReoptInRequest(actor, req.id);
      return sendError(reply, 502, "provider_error", "Message provider failed to send");
    }
    return reply.code(201).send({ ok: true, channel: req.channel, status: req.status, requestedAt: req.createdAt, expiresAt: req.expiresAt });
  });
  // ── Inbound SMS (Twilio) ──
  app.post(`${TWILIO_WEBHOOK_PREFIX}:orgId`, {
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const parsed = z.object({ orgId: z.string().uuid() }).safeParse(request.params);
    const params = (request.body && typeof request.body === "object" ? request.body : {}) as Record<string, string>;
    if (config.TWILIO_AUTH_TOKEN) {
      const url = `${config.PUBLIC_API_URL}${request.url}`;
      if (!verifyTwilioSignature(config.TWILIO_AUTH_TOKEN, url, params, request.headers["x-twilio-signature"])) {
        request.log.warn("rejected inbound SMS: bad Twilio signature");
        return sendError(reply, 403, "invalid_signature", "Invalid signature");
      }
    } else if (config.NODE_ENV === "production") {
      return sendError(reply, 503, "not_configured", "Inbound SMS is not configured");
    }
    reply.header("content-type", "text/xml; charset=utf-8");
    const from = params.From, text = typeof params.Body === "string" ? params.Body.trim().slice(0, 1600) : "";
    if (!parsed.success || typeof from !== "string" || !from || !text) return twiml(null);
    const { orgId } = parsed.data;
    if ((await store.orgDisplayName(orgId)) === null) return twiml(null);
    const keyword = parseKeyword(text);
    const sid = typeof params.MessageSid === "string" ? params.MessageSid.slice(0, 64) : null;
    // Every inbound text lands in Replies; keywords are logged there too.
    await store.appendMessage(orgId, "sms", from, {
      direction: "inbound", kind: keyword === "stop" ? "opt_out" : keyword === "start" ? "opt_in" : keyword ?? "message",
      status: "received", body: text, providerMessageId: sid
    });
    if (!keyword) return twiml(null);
    const storeName = (await store.orgDisplayName(orgId)) ?? config.BUSINESS_NAME;
    const meta = { requestId: sid ?? request.id };
    if (keyword === "stop") await store.addOptOut(orgId, "sms", from, "sms_stop", meta);
    if (keyword === "start") await store.removeOptOut(orgId, "sms", from, "sms_start", meta);
    const answer = keywordReply(keyword, storeName);
    await store.appendMessage(orgId, "sms", from, { direction: "outbound", kind: "auto", status: "sent", body: answer });
    return twiml(answer);
  });

  // ── Email unsubscribe (public; GET confirms, POST opts out) ──
  const unsubLimit = { rateLimit: { max: 30, timeWindow: "1 minute" } };
  /** Token → org + email address, from a deck delivery or a reply message. */
  async function resolve(token: unknown) { const id = verifyUnsubscribeToken(config.UNSUBSCRIBE_SIGNING_SECRET, token); return id ? resolveId(id) : null; }
  async function resolveId(id: string): Promise<{ orgId: string; recipient: string } | null> {
    const d = await store.getDelivery(id);
    if (d) return d.channel === "email" ? { orgId: d.orgId, recipient: d.recipient } : null;
    const m = await store.getOutboundMessage(id);
    return m && m.channel === "email" ? { orgId: m.orgId, recipient: m.contact } : null;
  }
  const invalid = (reply: FastifyReply) =>
    page(reply, 400, "Link not valid", "<p>This unsubscribe link is invalid. If you keep getting emails, reply to one and we'll remove you.</p>");

  app.get(UNSUBSCRIBE_PATH, { config: unsubLimit }, async (request, reply) => {
    const t = (request.query as Record<string, unknown>).t;
    const d = await resolve(t);
    if (!d) return invalid(reply);
    const name = (await store.orgDisplayName(d.orgId)) ?? config.BUSINESS_NAME;
    return page(reply, 200, "Unsubscribe?", `<p>Stop receiving marketing emails from <strong>${esc(name)}</strong>?</p>
<form method="post" action="${UNSUBSCRIBE_PATH}?t=${encodeURIComponent(String(t))}"><button type="submit">Unsubscribe</button></form>`);
  });

  app.post(UNSUBSCRIBE_PATH, { config: unsubLimit }, async (request, reply) => {
    const d = await resolve((request.query as Record<string, unknown>).t);
    if (!d) return invalid(reply);
    await store.addOptOut(d.orgId, "email", d.recipient, "email_unsubscribe", { requestId: request.id });
    const name = (await store.orgDisplayName(d.orgId)) ?? config.BUSINESS_NAME;
    const id = verifyUnsubscribeToken(config.UNSUBSCRIBE_SIGNING_SECRET, (request.query as Record<string, unknown>).t)!;
    const rt = purposeToken(config.UNSUBSCRIBE_SIGNING_SECRET, "resubscribe", id);
    return page(reply, 200, "You're unsubscribed", `<p>You won't receive any more marketing emails from <strong>${esc(name)}</strong>.</p>
<p>Changed your mind?</p><form method="post" action="${RESUBSCRIBE_PATH}?t=${encodeURIComponent(rt)}"><button class="ok" type="submit">Resubscribe</button></form>`);
  });

  /** "Changed your mind?" on the unsubscribe confirmation. POST only; signed for this purpose; idempotent. */
  app.post(RESUBSCRIBE_PATH, { config: unsubLimit }, async (request, reply) => {
    const id = verifyPurposeToken(config.UNSUBSCRIBE_SIGNING_SECRET, "resubscribe", (request.query as Record<string, unknown>).t);
    const d = id ? await resolveId(id) : null;
    if (!d) return invalid(reply);
    await store.removeOptOut(d.orgId, "email", d.recipient, "email_resubscribe", { requestId: request.id });
    const name = (await store.orgDisplayName(d.orgId)) ?? config.BUSINESS_NAME;
    return page(reply, 200, "You're resubscribed", `<p>Welcome back. You'll receive emails from <strong>${esc(name)}</strong> again. Every email has an unsubscribe link.</p>`);
  });
  // ── Re-opt-in confirmation (link from a store's re-opt-in request email). GET confirms, POST resubscribes. ──
  const reopt = async (t: unknown) => {
    const id = verifyPurposeToken(config.UNSUBSCRIBE_SIGNING_SECRET, "reoptin", t);
    return id ? store.getReoptInRequest(id) : null;
  };
  app.get(REOPTIN_PATH, { config: unsubLimit }, async (request, reply) => {
    const t = (request.query as Record<string, unknown>).t;
    const r = await reopt(t);
    if (!r) return invalid(reply);
    const name = (await store.orgDisplayName(r.orgId)) ?? config.BUSINESS_NAME;
    if (r.status === "expired") return page(reply, 410, "Link expired", "<p>This link has expired. You're still unsubscribed.</p>");
    if (r.status === "confirmed") return page(reply, 200, "You're resubscribed", `<p>You're already receiving emails from <strong>${esc(name)}</strong>.</p>`);
    return page(reply, 200, "Resubscribe?", `<p>Get deals from <strong>${esc(name)}</strong> by email again?</p>
<form method="post" action="${REOPTIN_PATH}?t=${encodeURIComponent(String(t))}"><button class="ok" type="submit">Yes, resubscribe me</button></form>
<p><small>Ignore this to stay unsubscribed.</small></p>`);
  });
  app.post(REOPTIN_PATH, { config: unsubLimit }, async (request, reply) => {
    const r = await reopt((request.query as Record<string, unknown>).t);
    if (!r) return invalid(reply);
    const done = await store.confirmReoptIn(r.id, { requestId: request.id });
    if (!done) return page(reply, 410, "Link expired", "<p>This link has expired. You're still unsubscribed.</p>");
    const name = (await store.orgDisplayName(r.orgId)) ?? config.BUSINESS_NAME;
    return page(reply, 200, "You're resubscribed", `<p>Welcome back. You'll receive emails from <strong>${esc(name)}</strong> again. Every email has an unsubscribe link.</p>`);
  });
}
