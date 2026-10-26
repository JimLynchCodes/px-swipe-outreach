import { randomUUID } from "node:crypto";
import type pg from "pg";
import { createPool } from "../db/pool.js";
import type { Delivery, DeliveryStatus, Metrics, Opportunity, Suggestion } from "../types.js";
import { StoreError, type NewDelivery, type OutreachStore } from "./types.js";

const OPP_SELECT = `
  SELECT o.id, o.tenant_id, o.status, o.score, o.rationale, o.created_at,
    c.id AS campaign_id, c.type AS campaign_type, c.name AS campaign_name,
    f.id AS offer_id, f.name AS offer_name, f.discount_percent, f.combinable,
    cu.id AS customer_id, cu.first_name, cu.last_name, cu.age, cu.gender, cu.location, cu.stores_shopped,
    cu.phone, cu.email, cu.sms_consent, cu.email_consent, cu.opted_out, cu.lifetime_spend_cents, cu.last_purchase_at
  FROM outreach_opportunities o
  JOIN campaigns c ON c.tenant_id=o.tenant_id AND c.id=o.campaign_id
  JOIN customers cu ON cu.tenant_id=o.tenant_id AND cu.id=o.customer_id
  LEFT JOIN offers f ON f.tenant_id=o.tenant_id AND f.id=o.offer_id AND f.active
    AND (f.starts_at IS NULL OR f.starts_at<=NOW()) AND (f.ends_at IS NULL OR f.ends_at>=NOW())`;

function toDelivery(r: any): Delivery {
  return {
    id: r.id, tenantId: r.tenant_id, opportunityId: r.opportunity_id, channel: r.channel,
    recipient: r.recipient, message: r.message, subject: r.subject, status: r.status,
    providerMessageId: r.provider_message_id, error: r.error, idempotencyKey: r.idempotency_key,
    createdAt: new Date(r.created_at).toISOString()
  };
}

export class PostgresStore implements OutreachStore {
  readonly pool: pg.Pool;
  constructor(connectionString: string) { this.pool = createPool(connectionString); }

  private async hydrate(rows: any[]): Promise<Opportunity[]> {
    if (!rows.length) return [];
    const tenantId = rows[0].tenant_id;
    const items = await this.pool.query<any>(`
      SELECT o.customer_id, oi.product_id, oi.product_name, oi.unit_price_cents, p.category, p.image_url, o.purchased_at
      FROM orders o JOIN order_items oi ON oi.tenant_id=o.tenant_id AND oi.order_id=o.id
      LEFT JOIN products p ON p.tenant_id=oi.tenant_id AND p.id=oi.product_id
      WHERE o.tenant_id=$1 AND o.customer_id = ANY($2::text[])
      ORDER BY o.purchased_at DESC`, [tenantId, rows.map(r => r.customer_id)]);
    return rows.map(r => {
      const purchases = items.rows.filter(i => i.customer_id === r.customer_id).map(i => ({
        productId: i.product_id, name: i.product_name, category: i.category, priceCents: i.unit_price_cents,
        imageUrl: i.image_url, purchasedAt: new Date(i.purchased_at).toISOString()
      }));
      return {
        id: r.id, tenantId: r.tenant_id, status: r.status, score: Number(r.score), rationale: r.rationale,
        campaign: { id: r.campaign_id, type: r.campaign_type, name: r.campaign_name },
        offer: r.offer_id ? { id: r.offer_id, name: r.offer_name, discountPercent: r.discount_percent, combinable: r.combinable } : null,
        customer: {
          id: r.customer_id, firstName: r.first_name, lastName: r.last_name, age: r.age, gender: r.gender,
          location: r.location, storesShopped: r.stores_shopped ?? [], phone: r.phone, email: r.email,
          smsConsent: r.sms_consent, emailConsent: r.email_consent, optedOut: r.opted_out,
          lifetimeSpendCents: r.lifetime_spend_cents,
          lastPurchaseAt: r.last_purchase_at ? new Date(r.last_purchase_at).toISOString() : null,
          itemsPurchased: purchases.length, purchases
        }
      };
    });
  }

  async listQueue(tenantId: string, limit: number) {
    const r = await this.pool.query(`${OPP_SELECT} WHERE o.tenant_id=$1 AND o.status IN ('pending','drafted')
      ORDER BY o.created_at ASC LIMIT $2`, [tenantId, limit]);
    const total = await this.pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM outreach_opportunities
      WHERE tenant_id=$1 AND status IN ('pending','drafted')`, [tenantId]);
    return { items: await this.hydrate(r.rows), total: total.rows[0].n };
  }

  async getOpportunity(tenantId: string, id: string) {
    const r = await this.pool.query(`${OPP_SELECT} WHERE o.tenant_id=$1 AND o.id=$2`, [tenantId, id]);
    return (await this.hydrate(r.rows))[0] ?? null;
  }

  private async event(db: pg.Pool | pg.PoolClient, tenantId: string, oppId: string, actor: string, type: string, details: unknown = {}) {
    await db.query(`INSERT INTO outreach_events (tenant_id,opportunity_id,actor_id,event_type,details) VALUES ($1,$2,$3,$4,$5)`,
      [tenantId, oppId, actor, type, JSON.stringify(details)]);
  }

  private async assertTransition(tenantId: string, id: string) {
    const r = await this.pool.query<any>(`SELECT status FROM outreach_opportunities WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
    if (!r.rows[0]) throw new StoreError("not_found", "Opportunity not found");
    throw new StoreError("conflict", `Opportunity already ${r.rows[0].status}`);
  }

  async skip(tenantId: string, id: string, actorId: string) {
    const r = await this.pool.query(`UPDATE outreach_opportunities SET status='skipped', updated_at=NOW()
      WHERE tenant_id=$1 AND id=$2 AND status IN ('pending','drafted')`, [tenantId, id]);
    if (!r.rowCount) await this.assertTransition(tenantId, id);
    await this.event(this.pool, tenantId, id, actorId, "skipped");
  }

  async saveSuggestion(tenantId: string, id: string, actorId: string, s: Suggestion) {
    const opp = await this.pool.query(`SELECT 1 FROM outreach_opportunities WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
    if (!opp.rowCount) throw new StoreError("not_found", "Opportunity not found");
    await this.pool.query(`INSERT INTO outreach_drafts (id,tenant_id,opportunity_id,channel,title,message,subject,rationale,source,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [randomUUID(), tenantId, id, s.channel, s.title, s.message, s.subject, s.reasoning, s.source, actorId]);
    await this.pool.query(`UPDATE outreach_opportunities SET status='drafted', updated_at=NOW()
      WHERE tenant_id=$1 AND id=$2 AND status='pending'`, [tenantId, id]);
    await this.event(this.pool, tenantId, id, actorId, "draft_generated", { channel: s.channel, source: s.source });
  }

  async createDelivery(tenantId: string, opportunityId: string, actorId: string, d: NewDelivery) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query(`SELECT * FROM message_deliveries WHERE tenant_id=$1 AND idempotency_key=$2`, [tenantId, d.idempotencyKey]);
      if (existing.rows[0]) { await client.query("ROLLBACK"); return { delivery: toDelivery(existing.rows[0]), duplicate: true }; }
      const lock = await client.query<any>(`SELECT status FROM outreach_opportunities WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenantId, opportunityId]);
      if (!lock.rows[0]) throw new StoreError("not_found", "Opportunity not found");
      if (!["pending", "drafted"].includes(lock.rows[0].status)) throw new StoreError("conflict", `Opportunity already ${lock.rows[0].status}`);
      const ins = await client.query(`INSERT INTO message_deliveries (id,tenant_id,opportunity_id,channel,recipient,message,subject,status,idempotency_key)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8) RETURNING *`,
        [randomUUID(), tenantId, opportunityId, d.channel, d.recipient, d.message, d.subject, d.idempotencyKey]);
      await client.query(`UPDATE outreach_opportunities SET status='queued', updated_at=NOW() WHERE tenant_id=$1 AND id=$2`, [tenantId, opportunityId]);
      await this.event(client, tenantId, opportunityId, actorId, "send_queued", { deliveryId: ins.rows[0].id, channel: d.channel });
      await client.query("COMMIT");
      return { delivery: toDelivery(ins.rows[0]), duplicate: false };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async getDelivery(id: string) {
    const r = await this.pool.query(`SELECT * FROM message_deliveries WHERE id=$1`, [id]);
    return r.rows[0] ? toDelivery(r.rows[0]) : null;
  }

  async listDeliveries(tenantId: string, opportunityId: string) {
    const r = await this.pool.query(`SELECT * FROM message_deliveries WHERE tenant_id=$1 AND opportunity_id=$2 ORDER BY created_at DESC`, [tenantId, opportunityId]);
    return r.rows.map(toDelivery);
  }

  async updateDelivery(id: string, status: DeliveryStatus, patch: { providerMessageId?: string; error?: string } = {}) {
    const r = await this.pool.query<any>(`UPDATE message_deliveries SET status=$2, provider_message_id=COALESCE($3,provider_message_id),
      error=COALESCE($4,error), updated_at=NOW() WHERE id=$1 RETURNING tenant_id, opportunity_id`,
      [id, status, patch.providerMessageId ?? null, patch.error?.slice(0, 1000) ?? null]);
    const row = r.rows[0];
    if (!row) throw new StoreError("not_found", "Delivery not found");
    if (status === "sent" || status === "failed") {
      await this.pool.query(`UPDATE outreach_opportunities SET status=$3, updated_at=NOW() WHERE tenant_id=$1 AND id=$2`,
        [row.tenant_id, row.opportunity_id, status]);
      await this.event(this.pool, row.tenant_id, row.opportunity_id, "system", status === "sent" ? "message_sent" : "message_failed", { deliveryId: id });
    }
  }

  async metrics(tenantId: string): Promise<Metrics> {
    const o = await this.pool.query<any>(`SELECT status, COUNT(*)::int AS count FROM outreach_opportunities WHERE tenant_id=$1 GROUP BY status`, [tenantId]);
    const d = await this.pool.query<any>(`SELECT status, channel, COUNT(*)::int AS count FROM message_deliveries WHERE tenant_id=$1 GROUP BY status, channel`, [tenantId]);
    return { opportunities: o.rows, deliveries: d.rows };
  }

  async reset(tenantId: string) {
    await this.pool.query(`UPDATE outreach_opportunities SET status='pending', updated_at=NOW() WHERE tenant_id=$1`, [tenantId]);
  }

  async close() { await this.pool.end(); }
}
