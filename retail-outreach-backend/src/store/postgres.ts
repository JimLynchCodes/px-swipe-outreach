import type pg from "pg";
import { createPool, type PoolOptions } from "../db/pool.js";
import { ACTIONABLE_STATUSES } from "../domain.js";
import type {
  Actor, Channel, Delivery, DeliveryStatus, Invitation, InvitationPreview, Membership, MemberRole, Metrics, Opportunity,
  Suggestion, SuppressionReason, TeamMember
} from "../types.js";
import { assertCanGrant, assertCanManage, assertCanModify } from "../team/policy.js";
import { StoreError, TEAM_ERRORS, teamError, type NewDelivery, type NewInvitation, type OutreachStore } from "./types.js";

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
      select p.customer_id, pi.product_id, pi.product_name, pi.unit_price_cents, pr.category, pr.image_url, p.purchased_at
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
        productId: i.product_id, name: i.product_name, category: i.category, priceCents: i.unit_price_cents,
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
          itemsPurchased: purchases.length, purchases
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
      await db.query(`insert into public.outreach_drafts (org_id, opportunity_id, channel, title, message, subject, rationale, source, created_by)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [actor.orgId, id, s.channel, s.title, s.message, s.subject, s.reasoning, s.source, actor.userId]);
      if (o.status === "pending") {
        await db.query(`update public.outreach_opportunities set status = 'drafted', updated_by = $3 where org_id = $1 and id = $2`,
          [actor.orgId, id, actor.userId]);
      }
      await this.event(db, actor, actor.orgId, id, "draft_generated", { channel: s.channel, source: s.source });
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
        await this.event(db, actor, actor.orgId, opportunityId, "send_queued", { deliveryId: r.rows[0].id, channel: d.channel });
        return { delivery: toDelivery(r.rows[0]), duplicate: false };
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

  async optOut(actor: Actor, opportunityId: string, channels: Channel[], reason: SuppressionReason) {
    await this.asUser(actor.userId, async db => {
      const o = await this.findOpp(db, actor, opportunityId, true);
      if (!o) throw new StoreError("not_found", "Opportunity not found");
      for (const ch of channels) {
        await db.query(`insert into public.suppressions (org_id, channel, value, reason, source, customer_id, created_by)
          select $1, $2::public.outreach_channel, v, $3, 'staff', $4, $5
          from (select public.normalize_contact($2::public.outreach_channel, $6) as v) x where v is not null
          on conflict (org_id, channel, value) do nothing`,
          [actor.orgId, ch, reason, o.customer.id, actor.userId, ch === "sms" ? o.customer.phone : o.customer.email]);
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
    const r = await this.pool.query(`select * from public.message_deliveries where id = $1`, [id]);
    return r.rows[0] ? toDelivery(r.rows[0]) : null;
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
