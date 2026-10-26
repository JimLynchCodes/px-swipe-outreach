import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "./config.js";
import { pool, query } from "./db/pool.js";
import { getUser } from "./auth.js";
import { getNextOpportunity, getOpportunity, getOffer } from "./services/campaigns.js";
import { pos } from "./services/pos.js";
import { generateDraft } from "./services/ai.js";
import { deliveryQueue } from "./queue.js";
import type { Channel } from "./types.js";

const app = Fastify({ logger: true });
await app.register(helmet);
await app.register(cors, { origin: config.NODE_ENV === "production" ? false : true });
await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });

app.addHook("onRequest", async (request, reply) => {
  try {
    (request as any).user = getUser(request);
  } catch {
    return reply.code(401).send({ error: "Authentication required" });
  }
});

app.get("/health", async () => ({ ok: true }));

app.get("/api/outreach/next", async (request, reply) => {
  const user = (request as any).user;
  const result = await getNextOpportunity(user.tenantId);
  if (!result) return reply.code(404).send({ error: "No opportunities available" });

  // Prefer SMS by default; fallback to email only when phone is absent/unusable.
  const preferredChannel: Channel | "unavailable" =
    result.customer.phone && result.customer.smsConsent && !result.customer.optedOut ? "sms" :
    result.customer.email && result.customer.emailConsent && !result.customer.optedOut ? "email" :
    "unavailable";

  return { ...result, preferredChannel };
});

const channelSchema = z.object({ channel: z.enum(["sms", "email"]) });

app.post("/api/outreach/:id/generate", async (request, reply) => {
  const user = (request as any).user;
  const params = z.object({ id: z.string().min(1) }).parse(request.params);
  const body = channelSchema.parse(request.body);
  const opp = await getOpportunity(user.tenantId, params.id);
  if (!opp) return reply.code(404).send({ error: "Opportunity not found" });
  const customer = await pos.getCustomerSummary(user.tenantId, opp.customer_id);
  if (!customer) return reply.code(404).send({ error: "Customer not found" });

  const permitted = body.channel === "sms"
    ? Boolean(customer.phone && customer.smsConsent && !customer.optedOut)
    : Boolean(customer.email && customer.emailConsent && !customer.optedOut);
  if (!permitted) return reply.code(422).send({ error: "No valid contact permission for this channel" });

  const offer = opp.offer_id ? await getOffer(user.tenantId, opp.offer_id) : null;
  if (opp.offer_id && !offer) return reply.code(422).send({ error: "Offer is inactive or invalid" });
  const products = await pos.getApprovedProducts(user.tenantId,
    customer.recentItems.map(p => p.category).filter((x): x is string => Boolean(x)));

  const draft = await generateDraft({
    customer,
    campaign: {
      id: opp.campaign_id, type: opp.campaign_type, name: opp.campaign_name,
      score: Number(opp.score), rationale: opp.rationale, offerId: opp.offer_id
    },
    channel: body.channel, products, offer,
    brandVoice: { tone: "friendly, warm, clear, never pushy", businessName: "our store" }
  });

  // Re-check model-chosen IDs against supplied products.
  const allowedIds = new Set(products.map(p => p.id));
  const recommendedProductIds = draft.recommendedProductIds.filter(id => allowedIds.has(id));
  const id = randomUUID();
  const saved = await query<any>(`
    INSERT INTO outreach_drafts
      (id,tenant_id,opportunity_id,channel,message,subject,rationale,offer_id,version)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
      COALESCE((SELECT MAX(version)+1 FROM outreach_drafts WHERE tenant_id=$2 AND opportunity_id=$3),1))
    RETURNING *
  `, [id, user.tenantId, params.id, body.channel, draft.message, draft.subject,
      draft.rationale, offer?.id ?? null]);

  await query(`UPDATE outreach_opportunities SET status='drafted', updated_at=NOW()
    WHERE tenant_id=$1 AND id=$2 AND status IN ('pending','drafted')`, [user.tenantId, params.id]);
  await query(`INSERT INTO outreach_events (tenant_id,opportunity_id,actor_id,event_type,details)
    VALUES ($1,$2,$3,'draft_generated',$4)`,
    [user.tenantId, params.id, user.id, JSON.stringify({ channel: body.channel, draftId: id })]);

  return { draft: saved.rows[0], recommendedProductIds };
});

app.patch("/api/outreach/:id/draft", async (request, reply) => {
  const user = (request as any).user;
  const params = z.object({ id: z.string().min(1) }).parse(request.params);
  const body = z.object({
    channel: z.enum(["sms", "email"]),
    message: z.string().trim().min(1).max(5000),
    subject: z.string().max(200).nullable().optional()
  }).parse(request.body);

  const opp = await getOpportunity(user.tenantId, params.id);
  if (!opp) return reply.code(404).send({ error: "Opportunity not found" });
  const customer = await pos.getCustomerSummary(user.tenantId, opp.customer_id);
  if (!customer) return reply.code(404).send({ error: "Customer not found" });
  const permitted = body.channel === "sms"
    ? Boolean(customer.phone && customer.smsConsent && !customer.optedOut)
    : Boolean(customer.email && customer.emailConsent && !customer.optedOut);
  if (!permitted) return reply.code(422).send({ error: "No valid contact permission for this channel" });

  const id = randomUUID();
  const result = await query<any>(`
    INSERT INTO outreach_drafts
      (id,tenant_id,opportunity_id,channel,message,subject,rationale,offer_id,version,edited_by)
    VALUES ($1,$2,$3,$4,$5,$6,'Edited by staff',$7,
      COALESCE((SELECT MAX(version)+1 FROM outreach_drafts WHERE tenant_id=$2 AND opportunity_id=$3),1),$8)
    RETURNING *
  `, [id, user.tenantId, params.id, body.channel, body.message, body.subject ?? null,
      opp.offer_id, user.id]);
  await query(`INSERT INTO outreach_events (tenant_id,opportunity_id,actor_id,event_type,details)
    VALUES ($1,$2,$3,'draft_edited',$4)`,
    [user.tenantId, params.id, user.id, JSON.stringify({ draftId: id, channel: body.channel })]);
  return { draft: result.rows[0] };
});

app.post("/api/outreach/:id/skip", async (request, reply) => {
  const user = (request as any).user;
  const params = z.object({ id: z.string().min(1) }).parse(request.params);
  const result = await query(`
    UPDATE outreach_opportunities SET status='skipped',updated_at=NOW()
    WHERE tenant_id=$1 AND id=$2 AND status IN ('pending','drafted')
  `, [user.tenantId, params.id]);
  if (!result.rowCount) return reply.code(404).send({ error: "Opportunity not found or already actioned" });
  await query(`INSERT INTO outreach_events (tenant_id,opportunity_id,actor_id,event_type)
    VALUES ($1,$2,$3,'skipped')`, [user.tenantId, params.id, user.id]);
  return { ok: true };
});

app.post("/api/outreach/:id/send", async (request, reply) => {
  const user = (request as any).user;
  const params = z.object({ id: z.string().min(1) }).parse(request.params);
  const body = z.object({
    channel: z.enum(["sms", "email"]),
    idempotencyKey: z.string().min(8).max(200)
  }).parse(request.body);

  const existing = await query<any>(`
    SELECT * FROM message_deliveries WHERE tenant_id=$1 AND idempotency_key=$2
  `, [user.tenantId, body.idempotencyKey]);
  if (existing.rows[0]) return { delivery: existing.rows[0], duplicateRequest: true };

  const client = await pool.connect();
  let deliveryId: string;
  try {
    await client.query("BEGIN");
    const lock = await client.query<any>(`
      SELECT * FROM outreach_opportunities
      WHERE tenant_id=$1 AND id=$2 FOR UPDATE
    `, [user.tenantId, params.id]);
    const opp = lock.rows[0];
    if (!opp || !["drafted", "pending"].includes(opp.status)) {
      await client.query("ROLLBACK");
      return reply.code(409).send({ error: "Opportunity is not sendable" });
    }
    const customerResult = await client.query<any>(`
      SELECT * FROM customers WHERE tenant_id=$1 AND id=$2
    `, [user.tenantId, opp.customer_id]);
    const customer = customerResult.rows[0];
    if (!customer || customer.opted_out) {
      await client.query("ROLLBACK");
      return reply.code(422).send({ error: "Customer is opted out or unavailable" });
    }
    const hasPermission = body.channel === "sms"
      ? Boolean(customer.phone && customer.sms_consent)
      : Boolean(customer.email && customer.email_consent);
    if (!hasPermission) {
      await client.query("ROLLBACK");
      return reply.code(422).send({ error: "No valid contact permission for this channel" });
    }

    const draftResult = await client.query<any>(`
      SELECT * FROM outreach_drafts
      WHERE tenant_id=$1 AND opportunity_id=$2 AND channel=$3
      ORDER BY version DESC LIMIT 1
    `, [user.tenantId, params.id, body.channel]);
    const draft = draftResult.rows[0];
    if (!draft) {
      await client.query("ROLLBACK");
      return reply.code(422).send({ error: "Generate or save a draft for this channel before sending" });
    }

    // Revalidate offer state immediately before sending.
    if (opp.offer_id) {
      const offerResult = await client.query<any>(`
        SELECT * FROM offers WHERE tenant_id=$1 AND id=$2 AND active=TRUE
          AND (starts_at IS NULL OR starts_at<=NOW())
          AND (ends_at IS NULL OR ends_at>=NOW())
      `, [user.tenantId, opp.offer_id]);
      if (!offerResult.rows[0]) {
        await client.query("ROLLBACK");
        return reply.code(422).send({ error: "Offer is no longer valid" });
      }
    }

    deliveryId = randomUUID();
    const recipient = body.channel === "sms" ? customer.phone : customer.email;
    await client.query(`
      INSERT INTO message_deliveries
        (id,tenant_id,opportunity_id,draft_id,channel,recipient,status,idempotency_key)
      VALUES ($1,$2,$3,$4,$5,$6,'queued',$7)
    `, [deliveryId, user.tenantId, params.id, draft.id, body.channel, recipient, body.idempotencyKey]);
    await client.query(`UPDATE outreach_opportunities SET status='queued',updated_at=NOW()
      WHERE tenant_id=$1 AND id=$2`, [user.tenantId, params.id]);
    await client.query(`INSERT INTO outreach_events (tenant_id,opportunity_id,actor_id,event_type,details)
      VALUES ($1,$2,$3,'send_queued',$4)`,
      [user.tenantId, params.id, user.id, JSON.stringify({ deliveryId, channel: body.channel })]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  // Queue after transaction. Production hardening: use a transactional outbox so queue failures cannot strand jobs.
  await deliveryQueue.add("send", { deliveryId }, {
    jobId: deliveryId, attempts: 5, backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: 1000, removeOnFail: 5000
  });
  return reply.code(202).send({ deliveryId, status: "queued" });
});

app.get("/api/outreach/:id/status", async (request, reply) => {
  const user = (request as any).user;
  const params = z.object({ id: z.string().min(1) }).parse(request.params);
  const result = await query<any>(`
    SELECT id, channel, status, provider_message_id, error, created_at, updated_at
    FROM message_deliveries WHERE tenant_id=$1 AND opportunity_id=$2
    ORDER BY created_at DESC
  `, [user.tenantId, params.id]);
  if (!result.rows.length) return reply.code(404).send({ error: "No deliveries found" });
  return { deliveries: result.rows };
});

app.get("/api/outreach/metrics", async (request) => {
  const user = (request as any).user;
  const result = await query<any>(`
    SELECT status, COUNT(*)::int AS count
    FROM outreach_opportunities WHERE tenant_id=$1 GROUP BY status
  `, [user.tenantId]);
  const deliveries = await query<any>(`
    SELECT status, channel, COUNT(*)::int AS count
    FROM message_deliveries WHERE tenant_id=$1 GROUP BY status, channel
  `, [user.tenantId]);
  return { opportunities: result.rows, deliveries: deliveries.rows };
});

app.setErrorHandler((error: any, _request, reply) => {
  app.log.error(error);
  const status = (error as any).statusCode ?? 500;
  return reply.code(status >= 400 && status < 600 ? status : 500).send({
    error: status >= 500 ? "Internal server error" : error.message
  });
});

await app.listen({ port: config.PORT, host: "0.0.0.0" });
app.log.info(`Outreach API listening on ${config.PORT}`);
