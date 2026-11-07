import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { SMS_MAX } from "../domain.js";
import { unsubscribeLink } from "../optout/unsubscribe.js";
import type { MessageProvider } from "../providers/messaging.js";
import type { OutreachStore } from "../store/types.js";
import type { Actor } from "../types.js";
import { extractReplyToken, parseAddress, stripQuoted } from "./inbound.js";

export const INBOUND_EMAIL_PATH = "/webhooks/email/inbound";

type Deps = {
  config: AppConfig; store: OutreachStore; messenger: MessageProvider; actorOf: (req: any) => Actor;
  sendError: (reply: FastifyReply, status: number, code: string, error: string) => FastifyReply;
};

/** Appends the org signature for the channel unless the text already ends with it. */
export function withSignature(body: string, signature: string, channel: "sms" | "email"): string {
  const b = body.trim();
  const sig = signature.trim();
  if (!sig || b.endsWith(sig)) return b;
  return channel === "sms" ? `${b} ${sig}` : `${b}\n\n${sig}`;
}

export const replyToAddress = (config: AppConfig, token: string | null | undefined) =>
  token && config.INBOUND_EMAIL_DOMAIN ? `reply+${token}@${config.INBOUND_EMAIL_DOMAIN}` : null;

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export async function replyRoutes(app: FastifyInstance, { config, store, messenger, actorOf, sendError }: Deps) {
  const idParam = z.object({ id: z.string().min(1).max(100) });

  app.get("/api/conversations", async request => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }).parse(request.query);
    return { conversations: await store.listConversations(actorOf(request), limit) };
  });
  app.get("/api/conversations/unread-count", async request => ({ count: await store.unreadCount(actorOf(request)) }));
  app.get("/api/conversations/:id", async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const thread = await store.getThread(actorOf(request), id);
    return thread ?? sendError(reply, 404, "not_found", "Conversation not found");
  });
  app.post("/api/conversations/:id/read", async request => {
    const { id } = idParam.parse(request.params);
    await store.markRead(actorOf(request), id);
    return { ok: true };
  });

  /** Reply on the thread's channel. Signature applied; blocked when the customer opted out of that channel. */
  app.post("/api/conversations/:id/messages", {
    config: { rateLimit: { max: config.SEND_RATE_LIMIT_PER_MINUTE, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = z.object({ body: z.string().trim().min(1).max(5000), subject: z.string().trim().max(200).nullish() }).strict().parse(request.body ?? {});
    const actor = actorOf(request);
    const thread = await store.getThread(actor, id);
    if (!thread) return sendError(reply, 404, "not_found", "Conversation not found");
    const { channel } = thread.conversation;
    if (thread.conversation.optedOut) {
      return sendError(reply, 422, "suppressed", `This customer opted out of ${channel === "sms" ? "text messages" : "email"}`);
    }
    const settings = await store.getSettings(actor);
    const text = withSignature(body.body, channel === "sms" ? settings.smsSignature : settings.emailSignature, channel);
    if (channel === "sms" && text.length > SMS_MAX) return sendError(reply, 400, "invalid_request", `SMS must be ${SMS_MAX} characters or fewer (including signature)`);
    const lastSubject = [...thread.messages].reverse().find(m => m.subject)?.subject;
    const subject = channel === "email"
      ? body.subject || (lastSubject ? (/^re:/i.test(lastSubject) ? lastSubject : `Re: ${lastSubject}`) : `A note from ${settings.storeName ?? request.auth!.org!.businessName ?? config.BUSINESS_NAME}`)
      : null;
    const created = await store.createReply(actor, id, { body: text, subject });
    try {
      const unsub = channel === "email" ? unsubscribeLink(config.PUBLIC_API_URL, config.UNSUBSCRIBE_SIGNING_SECRET, created.message.id) : null;
      const replyTo = replyToAddress(config, created.replyToken);
      const res = await messenger.send({
        channel, recipient: created.recipient, subject,
        message: unsub ? `${text}\n\nUnsubscribe: ${unsub.url}` : text,
        ...(channel === "email" ? { headers: { ...unsub!.headers, ...(replyTo ? { "Reply-To": replyTo } : {}) } } : {})
      });
      await store.updateMessageStatus(created.message.id, "sent", res.providerMessageId);
      return reply.code(201).send({ message: { ...created.message, status: "sent" } });
    } catch (e) {
      request.log.error({ err: e, messageId: created.message.id }, "reply send failed");
      await store.updateMessageStatus(created.message.id, "failed");
      return reply.code(502).send({ error: "Message provider failed to send", code: "provider_error", requestId: request.id,
        message: { ...created.message, status: "failed" } });
    }
  });

  /**
   * Inbound email (SendGrid Inbound Parse-style multipart/form, urlencoded or JSON: to, from, subject, text).
   * Protected by INBOUND_EMAIL_SECRET (?key=… or X-Inbound-Secret). Matched to a thread by the reply+<token>@ address.
   */
  app.post(INBOUND_EMAIL_PATH, { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (request, reply) => {
    const secret = config.INBOUND_EMAIL_SECRET;
    const given = String((request.query as Record<string, unknown>).key ?? request.headers["x-inbound-secret"] ?? "");
    if (!secret) return sendError(reply, 503, "not_configured", "Inbound email is not configured");
    if (!safeEqual(given, secret)) return sendError(reply, 403, "invalid_secret", "Invalid secret");
    const f = (request.body && typeof request.body === "object" ? request.body : {}) as Record<string, unknown>;
    const token = extractReplyToken(f.to, f.cc, f.envelope, f.To);
    const target = token ? await store.findReplyToken(token) : null;
    if (!target) return { ok: true, matched: false };
    const sender = parseAddress(f.from ?? f.From);
    if (!sender || sender !== target.contact) {
      request.log.warn("inbound email sender does not match the thread; ignored");
      return { ok: true, matched: false };
    }
    const text = typeof f.text === "string" && f.text.trim() ? f.text : typeof f.html === "string" ? f.html.replace(/<[^>]+>/g, " ") : "";
    if (!text.trim()) return { ok: true, matched: false };
    await store.appendMessage(target.orgId, "email", target.contact, {
      direction: "inbound", kind: "message", status: "received", body: stripQuoted(text),
      subject: typeof f.subject === "string" ? f.subject.slice(0, 300) : null
    });
    return { ok: true, matched: true };
  });
}
