import type pg from "pg";
import { createPool, type PoolOptions } from "../db/pool.js";
import { ACTIONABLE_STATUSES, maskRecipient } from "../domain.js";
import { newReplyToken } from "../replies/tokens.js";
import type {
  Actor, CatalogProduct, Channel, ConversationMessage, ConversationSummary, Deal, DealInput, NewMessage, OptOutEntry, OptOutSource, OrgSettings, ConsentEvent, ConsentMeta, OptInSource, ReoptInRequest, Delivery, DeliveryStatus, Invitation, InvitationPreview, Membership, MemberRole, Metrics, Opportunity,
  Suggestion, SuppressionReason, TeamMember
} from "../types.js";
import { REOPTIN_COOLDOWN_DAYS } from "../types.js";
import { assertCanEditDeals, assertCanManageConsent, assertReoptAllowed, assertCanGrant, assertCanManage, assertCanModify } from "../team/policy.js";
import { DEFAULT_SETTINGS, StoreError, TEAM_ERRORS, teamError, type NewDelivery, type NewInvitation, type OutreachStore } from "./types.js";

const INVITE_COLS = `id, org_id, email, role, invited_by, created_at, expires_at, last_sent_at, send_count, accepted_at, revoked_at`;
function toInvitation(r: any): Invitation {
  const status = r.revoked_at ? "revoked" : r.accepted_at ? "accepted" : new Date(r.expires_at).getTime() <= Date.now() ? "expired" : "pending";
  return {
    id: r.id, orgId: r.org_id, email: r.email, role: r.role, status, invitedBy: r.invited_by,
    createdAt: new Date(r.created_at).toISOString(), expiresAt: new Date(r.expires_at).toISOString(),
    lastSentAt: new Date(r.last_sent_at).toISOString(), sendCount: r.send_count
  };
}
/** Translate `raise exception 'last_owner'` etc. into StoreErrors. */
function mapTeamError(e: any): never {
  if (e?.code === "P0001" && typeof e.message === "string" && e.message in TEAM_ERRORS) throw teamError(e.message);
  if (e?.code === "42501") throw new StoreError("forbidden", "You don't have permission to do that", "insufficient_role");
  throw e;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: string) => UUID_RE.test(s);
const ACTIONABLE = `('${ACTIONABLE_STATUSES.join("','")}')`;

const OPP_SELECT = `
  select o.id, o.org_id, o.status, o.score, o.rationale,
    c.key as campaign_key, c.type as campaign_type, c.name as campaign_name,
    f.code as offer_code, f.name as offer_name, f.discount_percent, f.combinable,
    cu.id as customer_id, cu.first_name, cu.last_name, cu.age, cu.gender, cu.location,
    cu.phone, cu.email, cu.sms_consent, cu.email_consent, cu.lifetime_spend_cents, cu.last_purchase_at,
    cu.age_verified, cu.favorite_categories, cu.favorite_brands, cu.visits_per_month, cu.avg_basket_cents,
    cu.preferred_day, cu.preferred_time,
    array(select ch::text from unnest(array['sms','email']::public.outreach_channel[]) ch
      where exists (select 1 from public.suppressions s where s.org_id = o.org_id and s.channel = ch
        and s.value = public.normalize_contact(ch, case when ch = 'sms' then cu.phone else cu.email end))
    ) as suppressed
  from public.outreach_opportunities o
  join public.campaigns c on c.org_id = o.org_id and c.id = o.campaign_id
  join public.customers cu on cu.org_id = o.org_id and cu.id = o.customer_id
  left join public.offers f on f.org_id = o.org_id and f.id = o.offer_id and f.active
    and (f.starts_at is null or f.starts_at <= now()) and (f.ends_at is null or f.ends_at >= now())`;

function toDelivery(r: any): Delivery {
  return {
    id: r.id, orgId: r.org_id, opportunityId: r.opportunity_id, channel: r.channel,
    recipient: r.recipient, message: r.message, subject: r.subject, status: r.status,
    providerMessageId: r.provider_message_id, error: r.error, idempotencyKey: r.idempotency_key,
    createdAt: new Date(r.created_at).toISOString()
  };
}

type Db = pg.PoolClient;

const CONV_SELECT = `
  select c.id, c.channel, c.customer_id, c.contact_value, c.unread_count, c.last_message_at,
    nullif(btrim(coalesce(cu.first_name, '') || ' ' || coalesce(cu.last_name, '')), '') as customer_name,
    lm.body as last_body, lm.direction as last_direction,
    exists (select 1 from public.suppressions s where s.org_id = c.org_id and s.channel = c.channel and s.value = c.contact_value) as opted_out
  from public.conversations c
  left join public.customers cu on cu.org_id = c.org_id and cu.id = c.customer_id
  left join lateral (select body, direction from public.messages m where m.org_id = c.org_id and m.conversation_id = c.id
    order by created_at desc, id desc limit 1) lm on true`;
function toConversation(r: any): ConversationSummary {
  return {
    id: r.id, channel: r.channel, customerId: r.customer_id, customerName: r.customer_name, contact: maskRecipient(r.contact_value),
    lastMessageAt: new Date(r.last_message_at).toISOString(), lastMessagePreview: String(r.last_body ?? "").replace(/\s+/g, " ").slice(0, 140),
    lastDirection: r.last_direction ?? "outbound", unreadCount: r.unread_count, optedOut: r.opted_out
  };
}
function toMessage(r: any): ConversationMessage {
  return { id: r.id, conversationId: r.conversation_id, direction: r.direction, kind: r.kind, status: r.status, body: r.body,
    subject: r.subject, sentBy: r.sent_by, createdAt: new Date(r.created_at).toISOString() };
}

/** Appends to the (org, channel, contact) thread inside an existing transaction. */
export async function appendTx(db: Db, orgId: string, channel: Channel, contact: string, m: NewMessage) {
  const c = await db.query(`
    with v as (select public.normalize_contact($2::public.outreach_channel, $3) as value)
    insert into public.conversations (org_id, channel, contact_value, customer_id)
    select $1, $2, v.value, (select cu.id from public.customers cu where cu.org_id = $1
        and public.normalize_contact($2::public.outreach_channel, case when $2 = 'sms' then cu.phone else cu.email end) = v.value limit 1)
    from v where v.value is not null
    on conflict (org_id, channel, contact_value) do update set channel = excluded.channel
    returning id`, [orgId, channel, contact]);
  if (!c.rows[0]) throw new StoreError("not_found", "Invalid contact");
  const conversationId = c.rows[0].id as string;
  const replyToken = m.direction === "outbound" && channel === "email" ? newReplyToken() : null;
  const at = m.createdAt ?? new Date();
  const r = await db.query(`insert into public.messages (org_id, conversation_id, direction, kind, status, body, subject, sent_by,
      delivery_id, reply_token, provider_message_id, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
    [orgId, conversationId, m.direction, m.kind, m.status, m.body, m.subject ?? null, m.sentBy ?? null, m.deliveryId ?? null,
      replyToken, m.providerMessageId ?? null, at]);
  await db.query(`update public.conversations set last_message_at = greatest(last_message_at, $3),
      unread_count = unread_count + $4 where org_id = $1 and id = $2`, [orgId, conversationId, at, m.direction === "inbound" ? 1 : 0]);
  return { conversationId, messageId: r.rows[0].id as string, replyToken };
}

async function consentTx(db: Db, orgId: string, channel: Channel, value: string, event: ConsentEvent["event"], source: ConsentEvent["source"], meta: ConsentMeta = {}) {
  await db.query(`insert into public.consent_events (org_id, channel, value, event, source, actor_id, request_id) values ($1,$2,$3,$4,$5,$6,$7)`,
    [orgId, channel, value, event, source, meta.actorId ?? null, meta.requestId?.slice(0, 100) ?? null]);
}
const REOPT_LATEST = `(select row_to_json(x) from (select r.status, r.created_at, r.expires_at from public.reoptin_requests r
  where r.org_id = s.org_id and r.channel = s.channel and r.value = s.value and r.status <> 'cancelled' order by r.created_at desc limit 1) x)`;
function toReopt(j: any): OptOutEntry["reoptIn"] {
  if (!j) return null;
  const createdAt = new Date(j.created_at).toISOString(), expiresAt = new Date(j.expires_at).toISOString();
  const status = j.status === "pending" && Date.parse(expiresAt) <= Date.now() ? "expired" : j.status;
  return { status, requestedAt: createdAt, expiresAt, nextAllowedAt: new Date(Date.parse(createdAt) + REOPTIN_COOLDOWN_DAYS * 86_400_000).toISOString() };
}
const isoDay = (v: Date | string | null) => v === null ? null : typeof v === "string" ? v.slice(0, 10)
  : `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
function toDeal(r: any): Deal {
  return {
    id: r.id, orgId: r.org_id, schedule: r.schedule ?? "weekly", days: r.days.map(Number), title: r.title, description: r.description,
    discountType: r.discount_type, discountValue: r.discount_value, categories: r.categories, productIds: r.product_ids,
    startsOn: isoDay(r.starts_on), endsOn: isoDay(r.ends_on), active: r.active,
    createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString()
  };
}
const dealParams = (d: DealInput) => [d.days, d.title, d.description, d.discountType, d.discountValue, d.categories,
  d.productIds, d.startsOn, d.endsOn, d.active, d.schedule];
function toSettings(r: any): OrgSettings {
  return { storeName: r.store_name, emailSignature: r.email_signature, smsSignature: r.sms_signature,
    defaultChannel: r.default_channel, maxDiscountPercent: r.max_discount_percent };
}

export class PostgresStore implements OutreachStore {
  readonly kind = "postgres" as const;
  readonly pool: pg.Pool;
  constructor(connectionString: string, opts: PoolOptions = {}) { this.pool = createPool(connectionString, opts); }

  /**
   * Runs `fn` in a transaction as the Supabase `authenticated` role with the caller's JWT claims,
   * exactly as PostgREST would. RLS policies therefore enforce org isolation even if a query here
   * forgot an org filter. Settings are transaction-local (safe with pgbouncer transaction pooling).
   */
  async asUser<T>(userId: string, fn: (db: Db) => Promise<T>, email?: string | null): Promise<T> {
    return this.tx(async db => {
      const claims = { sub: userId, role: "authenticated", ...(email ? { email } : {}) };
      await db.query(`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`,
        [JSON.stringify(claims), userId]);
      await db.query("set local role authenticated");
      return fn(db);
    });
  }

  /** Privileged transaction (system work only: worker status updates, demo reset). */
  private async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query("begin");
      const out = await fn(db);
      await db.query("commit");
      return out;
    } catch (e) {
      await db.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      db.release();
    }
  }

  private async hydrate(db: Db, rows: any[]): Promise<Opportunity[]> {
    if (!rows.length) return [];
    const items = await db.query<any>(`
      select p.customer_id, pi.product_id, pi.product_name, pi.unit_price_cents, pr.category, pr.brand, pr.image_url, p.purchased_at
      from public.purchases p
      join public.purchase_items pi on pi.org_id = p.org_id and pi.purchase_id = p.id
      left join public.products pr on pr.org_id = pi.org_id and pr.id = pi.product_id
      where p.org_id = $1 and p.customer_id = any($2::uuid[])
      order by p.purchased_at desc`, [rows[0].org_id, rows.map(r => r.customer_id)]);
    const stores = await db.query<any>(`
      select p.customer_id, s.name, max(p.purchased_at) as last_at
      from public.purchases p join public.stores s on s.org_id = p.org_id and s.id = p.store_id
      where p.org_id = $1 and p.customer_id = any($2::uuid[])
      group by p.customer_id, s.name order by last_at desc`, [rows[0].org_id, rows.map(r => r.customer_id)]);
    return rows.map(r => {
      const purchases = items.rows.filter(i => i.customer_id === r.customer_id).map(i => ({
        productId: i.product_id, name: i.product_name, category: i.category, brand: i.brand, priceCents: i.unit_price_cents,
        imageUrl: i.image_url, purchasedAt: new Date(i.purchased_at).toISOString()
      }));
      return {
        id: r.id, orgId: r.org_id, status: r.status, score: Number(r.score), rationale: r.rationale,
        campaign: { id: r.campaign_key, type: r.campaign_type, name: r.campaign_name },
        offer: r.offer_code ? { id: r.offer_code, name: r.offer_name, discountPercent: r.discount_percent, combinable: r.combinable } : null,
        customer: {
          id: r.customer_id, firstName: r.first_name, lastName: r.last_name, age: r.age, gender: r.gender,
          location: r.location, storesShopped: stores.rows.filter(s => s.customer_id === r.customer_id).map(s => s.name),
          phone: r.phone, email: r.email, smsConsent: r.sms_consent, emailConsent: r.email_consent,
          suppressed: r.suppressed as Channel[],
          lifetimeSpendCents: Number(r.lifetime_spend_cents),
          lastPurchaseAt: r.last_purchase_at ? new Date(r.last_purchase_at).toISOString() : null,
          itemsPurchased: purchases.length, purchases,
          ageVerified: r.age_verified,
          profile: {
            favoriteCategories: r.favorite_categories, favoriteBrands: r.favorite_brands,
            visitsPerMonth: Number(r.visits_per_month), avgBasketCents: r.avg_basket_cents,
            preferredDay: r.preferred_day, preferredTime: r.preferred_time
          }
        }
      };
    });
  }

  private async findOpp(db: Db, actor: Actor, id: string, lock = false) {
    if (!isUuid(id)) return null;
    const r = await db.query(`${OPP_SELECT} where o.org_id = $1 and o.id = $2${lock ? " for update of o" : ""}`, [actor.orgId, id]);
    return (await this.hydrate(db, r.rows))[0] ?? null;
  }

  private async event(db: Db, actor: Actor | null, orgId: string, oppId: string | null, type: string, details: unknown = {}) {
    await db.query(`insert into public.outreach_events (org_id, opportunity_id, actor_id, event_type, details)
      values ($1, $2, $3, $4, $5)`, [orgId, oppId, actor?.userId ?? null, type, JSON.stringify(details)]);
  }

  private assertActionable(o: Opportunity | null): asserts o is Opportunity {
    if (!o) throw new StoreError("not_found", "Opportunity not found");
    if (!(ACTIONABLE_STATUSES as readonly string[]).includes(o.status)) throw new StoreError("conflict", `Opportunity already ${o.status}`);
  }

  async ping() { await this.pool.query("select 1"); }

  async listMemberships(userId: string): Promise<Membership[]> {
    if (!isUuid(userId)) return [];
    return this.asUser(userId, async db => {
      const r = await db.query(`select m.org_id, o.name, o.business_name, m.role
        from public.memberships m join public.organizations o on o.id = m.org_id
        where m.user_id = $1 order by o.name`, [userId]);
      return r.rows.map(x => ({ orgId: x.org_id, orgName: x.name, businessName: x.business_name, role: x.role }));
    });
  }

  async listQueue(actor: Actor, limit: number) {
    return this.asUser(actor.userId, async db => {
      const r = await db.query(`${OPP_SELECT} where o.org_id = $1 and o.status in ${ACTIONABLE}
        order by o.created_at asc, o.id limit $2`, [actor.orgId, limit]);
      const total = await db.query<{ n: number }>(`select count(*)::int as n from public.outreach_opportunities
        where org_id = $1 and status in ${ACTIONABLE}`, [actor.orgId]);
      return { items: await this.hydrate(db, r.rows), total: total.rows[0].n };
    });
  }

  async getOpportunity(actor: Actor, id: string) {
    return this.asUser(actor.userId, db => this.findOpp(db, actor, id));
  }

  async skip(actor: Actor, id: string) {
    await this.asUser(actor.userId, async db => {
      this.assertActionable(await this.findOpp(db, actor, id, true));
      await db.query(`update public.outreach_opportunities set status = 'skipped', updated_by = $3 where org_id = $1 and id = $2`,
        [actor.orgId, id, actor.userId]);
      await this.event(db, actor, actor.orgId, id, "skipped");
    });
  }

  async saveSuggestion(actor: Actor, id: string, s: Suggestion) {
    await this.asUser(actor.userId, async db => {
      const o = await this.findOpp(db, actor, id, true);
      if (!o) throw new StoreError("not_found", "Opportunity not found");
      await db.query(`insert into public.outreach_drafts (org_id, opportunity_id, channel, title, message, subject, rationale, source, created_by, deal_id)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [actor.orgId, id, s.channel, s.title, s.message, s.subject, s.reasoning, s.source, actor.userId,
        s.deal && isUuid(s.deal.id) ? s.deal.id : null]);
      if (o.status === "pending") {
        await db.query(`update public.outreach_opportunities set status = 'drafted', updated_by = $3 where org_id = $1 and id = $2`,
          [actor.orgId, id, actor.userId]);
      }
      await this.event(db, actor, actor.orgId, id, "draft_generated", { channel: s.channel, source: s.source, dealId: s.deal?.id ?? null });
    });
  }

  async createDelivery(actor: Actor, opportunityId: string, d: NewDelivery) {
    const findExisting = (db: Db) => db.query(`select * from public.message_deliveries where org_id = $1 and idempotency_key = $2`,
      [actor.orgId, d.idempotencyKey]);
    try {
      return await this.asUser(actor.userId, async db => {
        // Lock the opportunity first so a concurrent retry with the same key waits, then sees the committed delivery.
        const opp = await this.findOpp(db, actor, opportunityId, true);
        const existing = await findExisting(db);
        if (existing.rows[0]) return { delivery: toDelivery(existing.rows[0]), duplicate: true };
        this.assertActionable(opp);
        const r = await db.query(`insert into public.message_deliveries
            (org_id, opportunity_id, channel, recipient, message, subject, idempotency_key, status, created_by)
          values ($1,$2,$3,$4,$5,$6,$7,'queued',$8) returning *`,
          [actor.orgId, opportunityId, d.channel, d.recipient, d.message, d.subject, d.idempotencyKey, actor.userId]);
        await db.query(`update public.outreach_opportunities set status = 'queued', updated_by = $3 where org_id = $1 and id = $2`,
          [actor.orgId, opportunityId, actor.userId]);
        const msg = await appendTx(db, actor.orgId, d.channel, d.recipient, {
          direction: "outbound", kind: "message", status: "queued", body: d.message, subject: d.subject, sentBy: actor.userId, deliveryId: r.rows[0].id
        });
        await this.event(db, actor, actor.orgId, opportunityId, "send_queued", { deliveryId: r.rows[0].id, channel: d.channel });
        return { delivery: { ...toDelivery(r.rows[0]), replyToken: msg.replyToken }, duplicate: false };
      });
    } catch (e: any) {
      if (e?.code === "P0001" && e?.message === "recipient_suppressed") {
        throw new StoreError("suppressed", "Recipient has opted out of this channel");
      }
      if (e?.code === "23505") {
        // Lost a race with a concurrent request: same idempotency key -> return it; otherwise already sent.
        const again = await this.asUser(actor.userId, findExisting);
        if (again.rows[0]) return { delivery: toDelivery(again.rows[0]), duplicate: true };
        throw new StoreError("conflict", "A message for this opportunity is already in flight");
      }
      throw e;
    }
  }

  async listDeliveries(actor: Actor, opportunityId: string) {
    if (!isUuid(opportunityId)) return [];
    return this.asUser(actor.userId, async db => {
      const r = await db.query(`select * from public.message_deliveries where org_id = $1 and opportunity_id = $2
        order by created_at desc`, [actor.orgId, opportunityId]);
      return r.rows.map(toDelivery);
    });
  }

  async optOut(actor: Actor, opportunityId: string, channels: Channel[], reason: SuppressionReason, meta: ConsentMeta = {}) {
    await this.asUser(actor.userId, async db => {
      const o = await this.findOpp(db, actor, opportunityId, true);
      if (!o) throw new StoreError("not_found", "Opportunity not found");
      for (const ch of channels) {
        const added = await db.query(`insert into public.suppressions (org_id, channel, value, reason, source, customer_id, created_by)
          select $1, $2::public.outreach_channel, v, $3, 'manual', $4, $5
          from (select public.normalize_contact($2::public.outreach_channel, $6) as v) x where v is not null
          on conflict (org_id, channel, value) do nothing returning value`,
          [actor.orgId, ch, reason, o.customer.id, actor.userId, ch === "sms" ? o.customer.phone : o.customer.email]);
        if (added.rows[0]) await consentTx(db, actor.orgId, ch, added.rows[0].value, "opt_out", "manual", { actorId: actor.userId, requestId: meta.requestId });
      }
      if ((ACTIONABLE_STATUSES as readonly string[]).includes(o.status)) {
        await db.query(`update public.outreach_opportunities set status = 'suppressed', updated_by = $3 where org_id = $1 and id = $2`,
          [actor.orgId, opportunityId, actor.userId]);
      }
      await this.event(db, actor, actor.orgId, opportunityId, "opted_out", { channels, reason });
    });
  }

  async metrics(actor: Actor): Promise<Metrics> {
    return this.asUser(actor.userId, async db => {
      const o = await db.query(`select status::text, count(*)::int as count from public.outreach_opportunities where org_id = $1 group by status`, [actor.orgId]);
      const d = await db.query(`select status::text, channel::text, count(*)::int as count from public.message_deliveries where org_id = $1 group by status, channel`, [actor.orgId]);
      return { opportunities: o.rows, deliveries: d.rows };
    });
  }

  private async role(db: Db, actor: Actor) {
    const r = await db.query(`select role from public.memberships where org_id = $1 and user_id = $2`, [actor.orgId, actor.userId]);
    return r.rows[0]?.role as MemberRole | undefined;
  }

  async listDeals(actor: Actor) {
    return this.asUser(actor.userId, async db => {
      const r = await db.query(`select * from public.deals where org_id = $1 order by schedule desc, (select min(d) from unnest(days) d), starts_on nulls first, created_at`, [actor.orgId]);
      return r.rows.map(toDeal);
    });
  }
  async createDeal(actor: Actor, d: DealInput) {
    return this.asUser(actor.userId, async db => {
      assertCanEditDeals(await this.role(db, actor));
      const r = await db.query(`insert into public.deals (org_id, days, title, description, discount_type, discount_value, categories,
          product_ids, starts_on, ends_on, active, schedule, created_by)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`, [actor.orgId, ...dealParams(d), actor.userId]);
      await this.event(db, actor, actor.orgId, null, "deal_created", { dealId: r.rows[0].id });
      return toDeal(r.rows[0]);
    }).catch(mapTeamError);
  }
  async updateDeal(actor: Actor, id: string, d: DealInput) {
    if (!isUuid(id)) throw new StoreError("not_found", "Deal not found");
    return this.asUser(actor.userId, async db => {
      assertCanEditDeals(await this.role(db, actor));
      const r = await db.query(`update public.deals set days = $3, title = $4, description = $5, discount_type = $6, discount_value = $7,
          categories = $8, product_ids = $9, starts_on = $10, ends_on = $11, active = $12, schedule = $13
        where org_id = $1 and id = $2 returning *`, [actor.orgId, id, ...dealParams(d)]);
      if (!r.rows[0]) throw new StoreError("not_found", "Deal not found");
      await this.event(db, actor, actor.orgId, null, "deal_updated", { dealId: id });
      return toDeal(r.rows[0]);
    }).catch(mapTeamError);
  }
  async deleteDeal(actor: Actor, id: string) {
    if (!isUuid(id)) throw new StoreError("not_found", "Deal not found");
    await this.asUser(actor.userId, async db => {
      assertCanEditDeals(await this.role(db, actor));
      const r = await db.query(`delete from public.deals where org_id = $1 and id = $2`, [actor.orgId, id]);
      if (!r.rowCount) throw new StoreError("not_found", "Deal not found");
      await this.event(db, actor, actor.orgId, null, "deal_deleted", { dealId: id });
    }).catch(mapTeamError);
  }
  async listCatalog(actor: Actor): Promise<CatalogProduct[]> {
    return this.asUser(actor.userId, async db => {
      const r = await db.query(`select id, name, brand, category, price_cents from public.products where org_id = $1 and in_stock order by category, name`, [actor.orgId]);
      return r.rows.map(x => ({ id: x.id, name: x.name, brand: x.brand, category: x.category, priceCents: x.price_cents }));
    });
  }
  async getSettings(actor: Actor): Promise<OrgSettings> {
    return this.asUser(actor.userId, async db => {
      const r = await db.query(`select * from public.org_settings where org_id = $1`, [actor.orgId]);
      return r.rows[0] ? toSettings(r.rows[0]) : { ...DEFAULT_SETTINGS };
    });
  }
  async updateSettings(actor: Actor, s: OrgSettings): Promise<OrgSettings> {
    return this.asUser(actor.userId, async db => {
      assertCanEditDeals(await this.role(db, actor));
      const r = await db.query(`insert into public.org_settings (org_id, store_name, email_signature, sms_signature, default_channel, max_discount_percent, updated_by)
        values ($1,$2,$3,$4,$5,$6,$7)
        on conflict (org_id) do update set store_name = excluded.store_name, email_signature = excluded.email_signature,
          sms_signature = excluded.sms_signature, default_channel = excluded.default_channel,
          max_discount_percent = excluded.max_discount_percent, updated_by = excluded.updated_by
        returning *`, [actor.orgId, s.storeName, s.emailSignature, s.smsSignature, s.defaultChannel, s.maxDiscountPercent, actor.userId]);
      await this.event(db, actor, actor.orgId, null, "settings_updated", {});
      return toSettings(r.rows[0]);
    }).catch(mapTeamError);
  }

  async listOptOuts(actor: Actor, q: { channel?: Channel; search?: string; limit: number; offset: number }) {
    return this.asUser(actor.userId, async db => {
      const where = `s.org_id = $1 and ($2::public.outreach_channel is null or s.channel = $2)
        and ($3::text is null or s.value ilike '%' || $3 || '%' or (cu.first_name || ' ' || cu.last_name) ilike '%' || $3 || '%')`;
      const from = `from public.suppressions s left join lateral (select c.id, c.first_name, c.last_name from public.customers c
          where c.org_id = s.org_id and (c.id = s.customer_id or (s.customer_id is null and
            public.normalize_contact(s.channel, case when s.channel = 'sms' then c.phone else c.email end) = s.value)) limit 1) cu on true`;
      const search = q.search ? q.search.replace(/[\\%_]/g, m => `\\${m}`) : null;
      const params = [actor.orgId, q.channel ?? null, search];
      const total = await db.query(`select count(*)::int as n ${from} where ${where}`, params);
      const r = await db.query(`select s.id, s.channel, s.value, s.reason, s.source, s.created_at, cu.id as customer_id, ${REOPT_LATEST} as reopt,
          nullif(btrim(coalesce(cu.first_name, '') || ' ' || coalesce(cu.last_name, '')), '') as customer_name
        ${from} where ${where} order by s.created_at desc, s.id limit $4 offset $5`, [...params, q.limit, q.offset]);
      const items: OptOutEntry[] = r.rows.map(x => ({ id: x.id, channel: x.channel, contact: maskRecipient(x.value), customerId: x.customer_id,
        customerName: x.customer_name, source: x.source, reason: x.reason, createdAt: new Date(x.created_at).toISOString(), reoptIn: toReopt(x.reopt) }));
      return { items, total: total.rows[0].n };
    });
  }

  async listConsentEvents(actor: Actor, optOutId: string): Promise<ConsentEvent[]> {
    if (!isUuid(optOutId)) throw new StoreError("not_found", "Opt-out not found");
    return this.asUser(actor.userId, async db => {
      const s = await db.query(`select channel, value from public.suppressions where org_id = $1 and id = $2`, [actor.orgId, optOutId]);
      if (!s.rows[0]) throw new StoreError("not_found", "Opt-out not found");
      const r = await db.query(`select id, channel, event, source, actor_id, request_id, created_at from public.consent_events
        where org_id = $1 and channel = $2 and value = $3 order by created_at desc, id limit 200`, [actor.orgId, s.rows[0].channel, s.rows[0].value]);
      return r.rows.map(x => ({ id: x.id, channel: x.channel, event: x.event, source: x.source, actorId: x.actor_id, requestId: x.request_id,
        createdAt: new Date(x.created_at).toISOString() }));
    });
  }
  async createReoptInRequest(actor: Actor, optOutId: string, meta: ConsentMeta = {}, opts: { allowSms?: boolean } = {}) {
    if (!isUuid(optOutId)) throw new StoreError("not_found", "Opt-out not found");
    return this.asUser(actor.userId, async db => {
      assertCanManageConsent(await this.role(db, actor));
      const s = await db.query(`select s.*, ${REOPT_LATEST} as reopt from public.suppressions s where s.org_id = $1 and s.id = $2`, [actor.orgId, optOutId]); // the one-pending unique index guards races
      const row = s.rows[0];
      if (!row) throw new StoreError("not_found", "Opt-out not found");
      if (row.channel === "sms" && !opts.allowSms) throw new StoreError("forbidden", "Texting a number that replied STOP is restricted. SMS re-opt-in requests are off (ALLOW_SMS_REOPTIN_REQUEST).", "sms_reoptin_disabled");
      if (row.reason !== "opt_out") throw new StoreError("conflict", "Bounced or complained addresses can't be asked to re-subscribe", "not_reoptinable");
      const latest = toReopt(row.reopt);
      // A lapsed pending request no longer blocks; close it so the one-pending index allows a new one.
      if (latest?.status === "expired") await db.query(`update public.reoptin_requests set status = 'cancelled'
        where org_id = $1 and channel = $2 and value = $3 and status = 'pending'`, [actor.orgId, row.channel, row.value]);
      assertReoptAllowed(latest);
      const r = await db.query(`insert into public.reoptin_requests (org_id, channel, value, customer_id, requested_by, expires_at)
        values ($1,$2,$3,$4,$5, now() + make_interval(days => $6)) returning *`, [actor.orgId, row.channel, row.value, row.customer_id, actor.userId, REOPTIN_COOLDOWN_DAYS]);
      await consentTx(db, actor.orgId, row.channel, row.value, "reoptin_requested", "store_request", { actorId: actor.userId, requestId: meta.requestId });
      await this.event(db, actor, actor.orgId, null, "reoptin_requested", { channel: row.channel });
      const c = row.customer_id ? await db.query(`select first_name from public.customers where org_id = $1 and id = $2`, [actor.orgId, row.customer_id]) : null;
      const q = r.rows[0];
      return {
        request: { id: q.id, orgId: q.org_id, channel: q.channel, contact: q.value, status: "pending" as const,
          createdAt: new Date(q.created_at).toISOString(), expiresAt: new Date(q.expires_at).toISOString() },
        recipient: row.value as string, customerFirstName: (c?.rows[0]?.first_name as string | undefined) ?? null
      };
    }).catch(e => { if (e?.code === "23505") throw new StoreError("conflict", "A re-opt-in request is already pending for this contact", "reoptin_pending"); throw e; });
  }
  async cancelReoptInRequest(actor: Actor, requestId: string) {
    if (!isUuid(requestId)) return;
    await this.asUser(actor.userId, db => db.query(`update public.reoptin_requests set status = 'cancelled' where org_id = $1 and id = $2 and status = 'pending'`,
      [actor.orgId, requestId]));
  }

  async listConversations(actor: Actor, limit: number) {
    return this.asUser(actor.userId, async db =>
      (await db.query(`${CONV_SELECT} where c.org_id = $1 order by c.last_message_at desc limit $2`, [actor.orgId, limit])).rows.map(toConversation));
  }
  async unreadCount(actor: Actor) {
    return this.asUser(actor.userId, async db =>
      (await db.query(`select count(*)::int as n from public.conversations where org_id = $1 and unread_count > 0`, [actor.orgId])).rows[0].n as number);
  }
  async getThread(actor: Actor, id: string) {
    if (!isUuid(id)) return null;
    return this.asUser(actor.userId, async db => {
      const c = await db.query(`${CONV_SELECT} where c.org_id = $1 and c.id = $2`, [actor.orgId, id]);
      if (!c.rows[0]) return null;
      const m = await db.query(`select * from public.messages where org_id = $1 and conversation_id = $2 order by created_at, id`, [actor.orgId, id]);
      return { conversation: toConversation(c.rows[0]), messages: m.rows.map(toMessage) };
    });
  }
  async markRead(actor: Actor, id: string) {
    if (!isUuid(id)) throw new StoreError("not_found", "Conversation not found");
    await this.asUser(actor.userId, async db => {
      const r = await db.query(`update public.conversations set unread_count = 0, last_read_at = now() where org_id = $1 and id = $2`, [actor.orgId, id]);
      if (!r.rowCount) throw new StoreError("not_found", "Conversation not found");
    });
  }
  async createReply(actor: Actor, conversationId: string, msg: { body: string; subject: string | null }) {
    if (!isUuid(conversationId)) throw new StoreError("not_found", "Conversation not found");
    return this.asUser(actor.userId, async db => {
      const c = await db.query(`select c.channel, c.contact_value, exists (select 1 from public.suppressions s where s.org_id = c.org_id
          and s.channel = c.channel and s.value = c.contact_value) as opted_out
        from public.conversations c where c.org_id = $1 and c.id = $2 for update`, [actor.orgId, conversationId]);
      const row = c.rows[0];
      if (!row) throw new StoreError("not_found", "Conversation not found");
      if (row.opted_out) throw new StoreError("suppressed", `This customer opted out of ${row.channel === "sms" ? "text messages" : "email"}`);
      const r = await appendTx(db, actor.orgId, row.channel, row.contact_value,
        { direction: "outbound", kind: "message", status: "sending", body: msg.body, subject: msg.subject, sentBy: actor.userId });
      await this.event(db, actor, actor.orgId, null, "reply_sent", { conversationId });
      const m = await db.query(`select * from public.messages where id = $1`, [r.messageId]);
      return { message: toMessage(m.rows[0]), channel: row.channel as Channel, recipient: row.contact_value as string, replyToken: r.replyToken };
    });
  }

  // ── System (privileged) ──
  async appendMessage(orgId: string, channel: Channel, contact: string, m: NewMessage) {
    return this.tx(async db => {
      const r = await appendTx(db, orgId, channel, contact, m);
      await this.event(db, null, orgId, null, m.direction === "inbound" ? "reply_received" : "message_logged", { conversationId: r.conversationId, kind: m.kind });
      return r;
    });
  }
  async findReplyToken(token: string) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
    const r = await this.pool.query(`select c.org_id, c.channel, c.contact_value from public.messages m
      join public.conversations c on c.org_id = m.org_id and c.id = m.conversation_id where m.reply_token = $1`, [token]);
    return r.rows[0] ? { orgId: r.rows[0].org_id, channel: r.rows[0].channel as Channel, contact: r.rows[0].contact_value } : null;
  }
  async getOutboundMessage(id: string) {
    if (!isUuid(id)) return null;
    const r = await this.pool.query(`select c.org_id, c.channel, c.contact_value from public.messages m
      join public.conversations c on c.org_id = m.org_id and c.id = m.conversation_id where m.id = $1 and m.direction = 'outbound'`, [id]);
    return r.rows[0] ? { orgId: r.rows[0].org_id, channel: r.rows[0].channel as Channel, contact: r.rows[0].contact_value } : null;
  }
  async updateMessageStatus(id: string, status: "sent" | "failed", providerMessageId?: string | null) {
    if (!isUuid(id)) return;
    await this.pool.query(`update public.messages set status = $2, provider_message_id = coalesce($3, provider_message_id) where id = $1`,
      [id, status, providerMessageId ?? null]);
  }
  async getReoptInRequest(id: string): Promise<ReoptInRequest | null> {
    if (!isUuid(id)) return null;
    const r = await this.pool.query(`select * from public.reoptin_requests where id = $1 and status <> 'cancelled'`, [id]);
    const q = r.rows[0];
    if (!q) return null;
    const expiresAt = new Date(q.expires_at).toISOString();
    return { id: q.id, orgId: q.org_id, channel: q.channel, contact: q.value, createdAt: new Date(q.created_at).toISOString(), expiresAt,
      status: q.status === "pending" && Date.parse(expiresAt) <= Date.now() ? "expired" : q.status };
  }
  async confirmReoptIn(id: string, meta: ConsentMeta = {}) {
    const r = await this.getReoptInRequest(id);
    if (!r || r.status === "expired") return null;
    if (r.status === "confirmed") return { removed: false };
    return this.removeOptOut(r.orgId, r.channel, r.contact, "reoptin_link", meta);
  }
  async addOptOut(orgId: string, channel: Channel, contact: string, source: OptOutSource, meta: ConsentMeta = {}) {
    return this.tx(async db => {
      const r = await db.query(`insert into public.suppressions (org_id, channel, value, reason, source, customer_id)
        select $1, $2::public.outreach_channel, v.value, 'opt_out', $4,
          (select cu.id from public.customers cu where cu.org_id = $1
            and public.normalize_contact($2::public.outreach_channel, case when $2 = 'sms' then cu.phone else cu.email end) = v.value limit 1)
        from (select public.normalize_contact($2::public.outreach_channel, $3) as value) v where v.value is not null
        on conflict (org_id, channel, value) do nothing returning id, customer_id, value`, [orgId, channel, contact, source]);
      const created = (r.rowCount ?? 0) > 0;
      if (created) {
        await this.event(db, null, orgId, null, "opted_out", { channel, source, customerId: r.rows[0].customer_id });
        await consentTx(db, orgId, channel, r.rows[0].value, "opt_out", source, meta);
      }
      return { created };
    });
  }
  async removeOptOut(orgId: string, channel: Channel, contact: string, source: OptInSource, meta: ConsentMeta = {}) {
    return this.tx(async db => {
      const r = await db.query(`delete from public.suppressions where org_id = $1 and channel = $2 and reason = 'opt_out'
        and value = public.normalize_contact($2::public.outreach_channel, $3) returning value`, [orgId, channel, contact]);
      const removed = (r.rowCount ?? 0) > 0;
      if (removed) {
        const value = r.rows[0].value as string;
        await this.event(db, null, orgId, null, "opted_in", { channel, source });
        await consentTx(db, orgId, channel, value, "opt_in", source, meta);
        await db.query(`update public.reoptin_requests set status = 'confirmed', confirmed_at = now()
          where org_id = $1 and channel = $2 and value = $3 and status = 'pending'`, [orgId, channel, value]);
      }
      return { removed };
    });
  }
  async orgDisplayName(orgId: string) {
    if (!isUuid(orgId)) return null;
    const r = await this.pool.query(`select coalesce(s.store_name, o.business_name, o.name) as name from public.organizations o
      left join public.org_settings s on s.org_id = o.id where o.id = $1`, [orgId]);
    return (r.rows[0]?.name as string | undefined) ?? null;
  }

  async reset(actor: Actor) {
    const members = await this.listMemberships(actor.userId);
    if (!members.some(m => m.orgId === actor.orgId && m.role !== "staff")) {
      throw new StoreError("forbidden", "Only org owners/admins can reset demo data");
    }
    await this.tx(async db => {
      await db.query(`delete from public.message_deliveries where org_id = $1`, [actor.orgId]);
      await db.query(`delete from public.suppressions where org_id = $1`, [actor.orgId]);
      await db.query(`update public.outreach_opportunities set status = 'pending', updated_by = $2 where org_id = $1`, [actor.orgId, actor.userId]);
    });
  }

  async isSuppressed(orgId: string, channel: Channel, recipient: string) {
    const r = await this.pool.query(`select exists (select 1 from public.suppressions where org_id = $1 and channel = $2
      and value = public.normalize_contact($2::public.outreach_channel, $3)) as x`, [orgId, channel, recipient]);
    return r.rows[0].x as boolean;
  }
  async getDelivery(id: string) {
    if (!isUuid(id)) return null;
    const r = await this.pool.query(`select d.*, (select m.reply_token from public.messages m where m.delivery_id = d.id limit 1) as reply_token
      from public.message_deliveries d where d.id = $1`, [id]);
    return r.rows[0] ? { ...toDelivery(r.rows[0]), replyToken: r.rows[0].reply_token } : null;
  }

  async updateDelivery(id: string, status: DeliveryStatus, patch: { providerMessageId?: string; error?: string } = {}) {
    await this.tx(async db => {
      const r = await db.query(`update public.message_deliveries set status = $2,
          provider_message_id = coalesce($3, provider_message_id), error = coalesce($4, error)
        where id = $1 returning org_id, opportunity_id`, [id, status, patch.providerMessageId ?? null, patch.error ?? null]);
      if (!r.rows[0]) throw new StoreError("not_found", "Delivery not found");
      const { org_id, opportunity_id } = r.rows[0];
      if (status === "sent" || status === "failed") {
        await db.query(`update public.outreach_opportunities set status = $3 where org_id = $1 and id = $2`, [org_id, opportunity_id, status]);
        await this.event(db, null, org_id, opportunity_id, `delivery_${status}`, { deliveryId: id });
      }
      if (status !== "delivered") await db.query(`update public.messages set status = $2 where delivery_id = $1`, [id, status]);
    });
  }

  // ───────────────────────── Team management ─────────────────────────
  private async myRole(db: Db, actor: Actor): Promise<MemberRole> {
    const r = await db.query(`select role from public.memberships where org_id = $1 and user_id = $2`, [actor.orgId, actor.userId]);
    if (!r.rows[0]) throw new StoreError("forbidden", "Not a member of this organization");
    return r.rows[0].role;
  }

  async listMembers(actor: Actor): Promise<TeamMember[]> {
    return this.asUser(actor.userId, async db => {
      await this.myRole(db, actor);
      const r = await db.query(`select * from public.list_org_members($1)`, [actor.orgId]);
      return r.rows.map(x => ({ userId: x.user_id, email: x.email, role: x.role, joinedAt: new Date(x.joined_at).toISOString() }));
    });
  }

  async listInvitations(actor: Actor) {
    return this.asUser(actor.userId, async db => {
      assertCanManage(await this.myRole(db, actor));
      const r = await db.query(`select ${INVITE_COLS} from public.invitations
        where org_id = $1 and accepted_at is null and revoked_at is null order by created_at desc`, [actor.orgId]);
      return r.rows.map(toInvitation);
    });
  }

  async createInvitation(actor: Actor, inv: NewInvitation) {
    const email = inv.email.toLowerCase();
    try {
      return await this.asUser(actor.userId, async db => {
        assertCanGrant(await this.myRole(db, actor), inv.role);
        const member = await db.query(`select 1 from public.list_org_members($1) where lower(email) = $2`, [actor.orgId, email]);
        if (member.rows[0]) throw new StoreError("conflict", "That person is already a member", "already_member");
        const open = await db.query(`select id, expires_at from public.invitations
          where org_id = $1 and email = $2 and accepted_at is null and revoked_at is null for update`, [actor.orgId, email]);
        if (open.rows[0]) {
          if (new Date(open.rows[0].expires_at).getTime() > Date.now()) {
            throw new StoreError("conflict", "An invitation is already pending for that email", "already_invited");
          }
          await db.query(`update public.invitations set revoked_at = now(), revoked_by = $2 where id = $1`, [open.rows[0].id, actor.userId]);
        }
        const r = await db.query(`insert into public.invitations (org_id, email, role, token_hash, invited_by, expires_at)
          values ($1,$2,$3,$4,$5,$6) returning ${INVITE_COLS}`, [actor.orgId, email, inv.role, inv.tokenHash, actor.userId, inv.expiresAt]);
        await this.event(db, actor, actor.orgId, null, "invitation_created", { invitationId: r.rows[0].id, email, role: inv.role });
        return toInvitation(r.rows[0]);
      });
    } catch (e: any) {
      if (e?.code === "23505") throw new StoreError("conflict", "An invitation is already pending for that email", "already_invited");
      mapTeamError(e);
    }
  }

  private async lockOpenInvite(db: Db, actor: Actor, id: string) {
    const role = await this.myRole(db, actor);
    assertCanManage(role);
    if (!isUuid(id)) throw new StoreError("not_found", "Invitation not found");
    const r = await db.query(`select ${INVITE_COLS} from public.invitations
      where org_id = $1 and id = $2 and accepted_at is null and revoked_at is null for update`, [actor.orgId, id]);
    if (!r.rows[0]) throw new StoreError("not_found", "Invitation not found");
    assertCanGrant(role, r.rows[0].role);
    return r.rows[0];
  }

  async refreshInvitation(actor: Actor, id: string, next: { tokenHash: string; expiresAt: Date; cooldownSeconds: number }) {
    return this.asUser(actor.userId, async db => {
      const row = await this.lockOpenInvite(db, actor, id);
      if (Date.now() - new Date(row.last_sent_at).getTime() < next.cooldownSeconds * 1000) {
        throw new StoreError("conflict", "This invitation was just sent. Try again in a minute.", "resend_cooldown");
      }
      const r = await db.query(`update public.invitations set token_hash = $2, expires_at = $3, last_sent_at = now(), send_count = send_count + 1
        where id = $1 returning ${INVITE_COLS}`, [id, next.tokenHash, next.expiresAt]);
      await this.event(db, actor, actor.orgId, null, "invitation_resent", { invitationId: id, email: row.email, sendCount: r.rows[0].send_count });
      return toInvitation(r.rows[0]);
    }).catch(mapTeamError);
  }

  async revokeInvitation(actor: Actor, id: string) {
    await this.asUser(actor.userId, async db => {
      const row = await this.lockOpenInvite(db, actor, id);
      await db.query(`update public.invitations set revoked_at = now(), revoked_by = $2 where id = $1`, [id, actor.userId]);
      await this.event(db, actor, actor.orgId, null, "invitation_revoked", { invitationId: id, email: row.email });
    }).catch(mapTeamError);
  }

  private async targetRole(db: Db, actor: Actor, userId: string): Promise<MemberRole> {
    if (!isUuid(userId)) throw new StoreError("not_found", "Member not found");
    const r = await db.query(`select role from public.memberships where org_id = $1 and user_id = $2`, [actor.orgId, userId]);
    if (!r.rows[0]) throw new StoreError("not_found", "Member not found");
    return r.rows[0].role;
  }

  async changeMemberRole(actor: Actor, userId: string, role: MemberRole) {
    await this.asUser(actor.userId, async db => {
      const mine = await this.myRole(db, actor);
      const current = await this.targetRole(db, actor, userId);
      assertCanModify(mine, current);
      assertCanGrant(mine, role);
      if (current === role) return;
      const r = await db.query(`update public.memberships set role = $3 where org_id = $1 and user_id = $2`, [actor.orgId, userId, role]);
      if (r.rowCount !== 1) throw new StoreError("forbidden", "You don't have permission to do that", "insufficient_role");
      await this.event(db, actor, actor.orgId, null, "member_role_changed", { userId, from: current, to: role });
    }).catch(mapTeamError);
  }

  async removeMember(actor: Actor, userId: string) {
    await this.asUser(actor.userId, async db => {
      const mine = await this.myRole(db, actor);
      const current = await this.targetRole(db, actor, userId);
      const self = userId === actor.userId;
      if (!self) assertCanModify(mine, current);
      // Audit first: after a self-removal the actor can no longer write events for this org under RLS.
      await this.event(db, actor, actor.orgId, null, self ? "member_left" : "member_removed", { userId, role: current });
      const r = await db.query(`delete from public.memberships where org_id = $1 and user_id = $2`, [actor.orgId, userId]);
      if (r.rowCount !== 1) throw new StoreError("forbidden", "You don't have permission to do that", "insufficient_role");
    }).catch(mapTeamError);
  }

  async acceptInvitation(user: { id: string; email: string | null }, tokenHash: string) {
    if (!isUuid(user.id)) throw teamError("invitation_invalid");
    return this.asUser(user.id, async db => {
      const r = await db.query(`select * from public.accept_invitation($1)`, [tokenHash]);
      return { orgId: r.rows[0].org_id, role: r.rows[0].role, alreadyMember: r.rows[0].already_member };
    }, user.email?.toLowerCase()).catch(mapTeamError);
  }

  async previewInvitation(tokenHash: string): Promise<InvitationPreview | null> {
    const r = await this.pool.query(`select * from public.preview_invitation($1)`, [tokenHash]);
    const x = r.rows[0];
    return x ? { orgName: x.org_name, email: x.email, role: x.role, status: x.status, expiresAt: new Date(x.expires_at).toISOString() } : null;
  }

  async close() { await this.pool.end(); }
}
