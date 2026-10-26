import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { z, ZodError } from "zod";
import type { AppConfig } from "./config.js";
import { resolveUser } from "./auth.js";
import { canContact, recipientFor, toCardDto } from "./domain.js";
import { processDelivery } from "./delivery.js";
import type { SuggestionProvider } from "./providers/ai.js";
import type { MessageProvider } from "./providers/messaging.js";
import { StoreError, type OutreachStore } from "./store/types.js";

export type AppDeps = {
  config: AppConfig;
  store: OutreachStore;
  suggestions: SuggestionProvider;
  messenger: MessageProvider;
  /** Present only in DELIVERY_MODE=queue. */
  enqueueDelivery?: (deliveryId: string) => Promise<void>;
  logger?: boolean;
};

const SMS_MAX = 480; // ~3 SMS segments
const idParams = z.object({ id: z.string().min(1).max(100) });
const channel = z.enum(["sms", "email"]);

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, store, suggestions, messenger } = deps;
  const app = Fastify({ logger: deps.logger ?? true });

  await app.register(helmet);
  const origins = config.CORS_ORIGIN.split(",").map(s => s.trim()).filter(Boolean);
  await app.register(cors, { origin: origins.includes("*") ? true : origins, methods: ["GET", "POST", "OPTIONS"] });
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });

  app.decorateRequest("user", null as any);
  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health") return;
    try { request.user = resolveUser(request, config); }
    catch { return reply.code(401).send({ error: "Authentication required" }); }
  });

  app.setErrorHandler((error: any, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "Invalid request", details: error.issues.map(i => `${i.path.join(".")}: ${i.message}`) });
    }
    if (error instanceof StoreError) {
      return reply.code(error.code === "not_found" ? 404 : 409).send({ error: error.message });
    }
    const status = error.statusCode ?? 500;
    if (status >= 500) request.log.error(error);
    return reply.code(status).send({ error: status >= 500 ? "Internal server error" : error.message });
  });

  app.get("/health", async () => ({
    ok: true, store: config.DATA_STORE, delivery: config.DELIVERY_MODE,
    ai: suggestions.name, messaging: `${config.SMS_PROVIDER}/${config.EMAIL_PROVIDER}`
  }));

  /** The swipe deck. */
  app.get("/api/outreach/queue", async request => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(request.query);
    const { items, total } = await store.listQueue(request.user.tenantId, limit);
    return { items: items.map(o => toCardDto(o)), total };
  });

  app.get("/api/outreach/:id", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const opp = await store.getOpportunity(request.user.tenantId, id);
    if (!opp) return reply.code(404).send({ error: "Opportunity not found" });
    return toCardDto(opp);
  });

  /** AI suggestion (title, reasoning, message) for a channel. */
  app.post("/api/outreach/:id/suggestion", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = z.object({ channel }).parse(request.body ?? {});
    const opp = await store.getOpportunity(request.user.tenantId, id);
    if (!opp) return reply.code(404).send({ error: "Opportunity not found" });
    if (!canContact(opp.customer, body.channel)) {
      return reply.code(422).send({ error: `Customer cannot be contacted by ${body.channel}` });
    }
    const suggestion = await suggestions.suggest({ opportunity: opp, channel: body.channel, businessName: config.BUSINESS_NAME });
    await store.saveSuggestion(request.user.tenantId, id, request.user.id, suggestion);
    return { suggestion };
  });

  app.post("/api/outreach/:id/skip", async request => {
    const { id } = idParams.parse(request.params);
    await store.skip(request.user.tenantId, id, request.user.id);
    return { ok: true, status: "skipped" };
  });

  /** Send the (possibly edited) message. Idempotent per idempotencyKey. */
  app.post("/api/outreach/:id/send", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = z.object({
      channel,
      message: z.string().trim().min(1).max(5000),
      subject: z.string().trim().max(200).nullish(),
      idempotencyKey: z.string().min(8).max(200)
    }).parse(request.body ?? {});
    if (body.channel === "sms" && body.message.length > SMS_MAX) {
      return reply.code(400).send({ error: `SMS must be ${SMS_MAX} characters or fewer` });
    }
    const { tenantId, id: actorId } = request.user;
    const opp = await store.getOpportunity(tenantId, id);
    if (!opp) return reply.code(404).send({ error: "Opportunity not found" });
    if (!canContact(opp.customer, body.channel)) {
      return reply.code(422).send({ error: `Customer cannot be contacted by ${body.channel}` });
    }
    const subject = body.channel === "email" ? (body.subject || "A note from " + config.BUSINESS_NAME) : null;
    const { delivery, duplicate } = await store.createDelivery(tenantId, id, actorId, {
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
      request.log.error(e, "delivery failed");
      return reply.code(502).send({ deliveryId: delivery.id, status: "failed", error: "Message provider failed to send" });
    }
  });

  app.get("/api/outreach/:id/deliveries", async request => {
    const { id } = idParams.parse(request.params);
    const deliveries = await store.listDeliveries(request.user.tenantId, id);
    // Recipient is masked; the browser never needs the raw contact detail.
    return { deliveries: deliveries.map(({ recipient, tenantId: _t, ...d }) => ({ ...d, recipient: recipient.replace(/^(.{3}).*(.{2})$/, "$1***$2") })) };
  });

  app.get("/api/metrics", async request => store.metrics(request.user.tenantId));

  /** Development helper so the demo deck can be replayed. */
  if (config.NODE_ENV !== "production") {
    app.post("/api/dev/reset", async request => {
      await store.reset(request.user.tenantId);
      return { ok: true };
    });
  }

  return app;
}
