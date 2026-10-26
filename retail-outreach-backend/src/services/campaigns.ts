import { randomUUID } from "node:crypto";
import { query } from "../db/pool.js";
import { pos } from "./pos.js";
import type { CampaignCandidate, ApprovedOffer } from "../types.js";

export async function getOpportunity(tenantId: string, opportunityId: string) {
  const r = await query<any>(`
    SELECT o.*, c.name AS campaign_name, c.type AS campaign_type
    FROM outreach_opportunities o
    JOIN campaigns c ON c.tenant_id=o.tenant_id AND c.id=o.campaign_id
    WHERE o.tenant_id=$1 AND o.id=$2
  `, [tenantId, opportunityId]);
  return r.rows[0] ?? null;
}

export async function getNextOpportunity(tenantId: string) {
  const r = await query<any>(`
    SELECT o.id, o.customer_id, o.campaign_id, o.offer_id, o.score, o.rationale,
           c.name AS campaign_name, c.type AS campaign_type
    FROM outreach_opportunities o
    JOIN campaigns c ON c.tenant_id=o.tenant_id AND c.id=o.campaign_id
    WHERE o.tenant_id=$1 AND o.status IN ('pending','drafted')
    ORDER BY o.score DESC, o.created_at ASC LIMIT 1
  `, [tenantId]);
  if (!r.rows[0]) return null;
  const row = r.rows[0];
  const customer = await pos.getCustomerSummary(tenantId, row.customer_id);
  if (!customer) return null;
  const offer = row.offer_id ? await getOffer(tenantId, row.offer_id) : null;
  return {
    opportunity: {
      id: row.id, type: row.campaign_type, name: row.campaign_name,
      score: Number(row.score), rationale: row.rationale, offerId: row.offer_id
    } satisfies CampaignCandidate,
    customer,
    offer
  };
}

export async function getOffer(tenantId: string, offerId: string): Promise<ApprovedOffer | null> {
  const r = await query<any>(`
    SELECT id, name, discount_percent, combinable, active, starts_at, ends_at
    FROM offers WHERE tenant_id=$1 AND id=$2
  `, [tenantId, offerId]);
  const o = r.rows[0];
  if (!o || !o.active) return null;
  const now = Date.now();
  if (o.starts_at && new Date(o.starts_at).getTime() > now) return null;
  if (o.ends_at && new Date(o.ends_at).getTime() < now) return null;
  return { id: o.id, name: o.name, discountPercent: o.discount_percent, combinable: o.combinable };
}

/** MVP rule-based candidate creation. Call periodically from a scheduler. */
export async function buildCandidates(tenantId: string) {
  const customers = await query<any>(`
    SELECT id, lifetime_spend_cents,
      CASE WHEN last_purchase_at IS NULL THEN 9999
           ELSE FLOOR(EXTRACT(EPOCH FROM (NOW()-last_purchase_at))/86400)::int END AS days_ago
    FROM customers WHERE tenant_id=$1 AND opted_out=FALSE
  `, [tenantId]);
  let created = 0;
  for (const c of customers.rows) {
    const campaign = c.days_ago >= 60 ? "winback" :
      c.lifetime_spend_cents >= 100000 ? "vip" : null;
    if (!campaign) continue;
    const exists = await query(`
      SELECT 1 FROM outreach_opportunities
      WHERE tenant_id=$1 AND customer_id=$2 AND campaign_id=$3
        AND created_at > NOW()-INTERVAL '7 days'
        AND status NOT IN ('skipped','failed')
      LIMIT 1
    `, [tenantId, c.id, campaign]);
    if (exists.rowCount) continue;
    const id = randomUUID();
    const offerId = campaign === "winback" ? "WINBACK10" : null;
    const score = campaign === "winback" ? 80 : 70;
    const rationale = campaign === "winback"
      ? `No purchase in ${c.days_ago} days`
      : "High lifetime spend; consider a thank-you";
    await query(`
      INSERT INTO outreach_opportunities
      (id,tenant_id,customer_id,campaign_id,offer_id,score,rationale,status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')
    `, [id, tenantId, c.id, campaign, offerId, score, rationale]);
    created++;
  }
  return { created };
}
