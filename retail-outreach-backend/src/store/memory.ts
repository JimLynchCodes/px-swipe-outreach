import { randomUUID } from "node:crypto";
import { newReplyToken } from "../replies/tokens.js";
import * as seed from "../data/seed.js";
import { buildDemoMetrics } from "../data/demoMetrics.js";
import type { AiUsageInput, AiUsageRow, PurchaseRow, SendInput, SendRow, SmsCostInput, SmsCostRow } from "../metrics/types.js";
import { daysSince, inDeck, NO_COOLDOWN, ACTIONABLE_STATUSES, maskRecipient, normalizeContact, recipientFor, segmentOf } from "../domain.js";
import type {
  Actor, CatalogProduct, Channel, ConversationMessage, ConversationSummary, Customer, Deal, DealInput, NewMessage, OptOutEntry, OptOutSource, OrgSettings, ConsentEvent, ConsentMeta, OptInSource, ReoptInRequest, Delivery, DeliveryStatus, Invitation, InvitationPreview, Membership, MemberRole, Metrics,
  Opportunity, Suggestion, SuppressionReason, TeamMember
} from "../types.js";
import { REOPTIN_COOLDOWN_DAYS } from "../types.js";
import { assertCanEditDeals, assertCanManageConsent, assertReoptAllowed, assertCanGrant, assertCanManage, assertCanModify } from "../team/policy.js";
import { IN_STORE_SIGNUP, isExisting, phoneKey, emailKey, type ImportConsent, type ImportCustomer } from "../customers/csvImport.js";
import { splitName } from "../sync/quickvee/normalize.js";
import type { Order } from "../sync/types.js";
import { IMPORT_RATIONALE, MANUAL_CAMPAIGN, PICK_RATIONALE, toSummary } from "../customers/summary.js";
import { DEFAULT_SETTINGS, StoreError, type Cooldowns, teamError, type NewDelivery, type NewInvitation, type OutreachStore } from "./types.js";

type InvitationRow = {
  id: string; orgId: string; email: string; role: MemberRole; tokenHash: string; invitedBy: string | null;
  createdAt: Date; expiresAt: Date; lastSentAt: Date; sendCount: number;
  acceptedAt: Date | null; acceptedBy: string | null; revokedAt: Date | null; revokedBy: string | null;
};
const statusOf = (r: InvitationRow, now = Date.now()) =>
  r.revokedAt ? "revoked" as const : r.acceptedAt ? "accepted" as const : r.expiresAt.getTime() <= now ? "expired" as const : "pending" as const;
const isOpen = (r: InvitationRow) => !r.acceptedAt && !r.revokedAt;

const DAY_MS = 86_400_000;

export function buildSeedOpportunities(now = Date.now(), orgId = seed.DEMO_ORG_ID): Opportunity[] {
  return seed.customers.map((sc, i) => {
    const purchases = sc.purchases.map(([pid, daysAgo], j) => {
      const p = seed.productById(pid);
      return {
        productId: p.id, name: p.name, category: p.category, brand: p.brand, priceCents: p.priceCents,
        imageUrl: p.imageUrl, purchasedAt: new Date(now - daysAgo * DAY_MS - j * 60_000).toISOString()
      };
    });
    const customer: Customer = {
      id: sc.id, firstName: sc.firstName, lastName: sc.lastName, age: sc.age, gender: sc.gender,
      location: sc.location, storesShopped: sc.storesShopped, phone: sc.phone, email: sc.email,
      smsConsent: sc.smsConsent, emailConsent: sc.emailConsent, suppressed: [],
      lifetimeSpendCents: seed.lifetimeSpend(sc),
      lastPurchaseAt: purchases[0]?.purchasedAt ?? null,
      itemsPurchased: purchases.length,
      purchases,
      ageVerified: sc.ageVerified,
      lastSmsAt: seed.SEED_LAST_CONTACT[sc.id]?.smsDaysAgo !== undefined ? new Date(now - seed.SEED_LAST_CONTACT[sc.id].smsDaysAgo! * DAY_MS).toISOString() : null,
      lastEmailAt: seed.SEED_LAST_CONTACT[sc.id]?.emailDaysAgo !== undefined ? new Date(now - seed.SEED_LAST_CONTACT[sc.id].emailDaysAgo! * DAY_MS).toISOString() : null,
      rewards: seed.SEED_REWARDS[sc.id] ? { member: true, ...seed.SEED_REWARDS[sc.id] } : null,
      profile: { ...sc.profile, favoriteCategories: [...sc.profile.favoriteCategories], favoriteBrands: [...sc.profile.favoriteBrands] }
    };
    const pick = seed.chooseCampaign(segmentOf(customer, now), customer.lifetimeSpendCents, daysSince(customer.lastPurchaseAt, now) ?? 999);
    const campaign = seed.campaigns.find(x => x.id === pick.campaignId)!;
    return {
      id: `opp_${String(i + 1).padStart(4, "0")}`,
      orgId,
      status: "pending",
      campaign: { ...campaign },
      score: pick.score,
      rationale: pick.rationale,
      offer: seed.offers.find(o => o.id === pick.offerId) ?? null,
      customer
    };
  });
}

export function buildSeedDeals(orgId = seed.DEMO_ORG_ID, now = new Date()): Deal[] {
  return seed.deals.map((d, i) => ({
    ...structuredClone(d), id: `deal_${String(i + 1).padStart(4, "0")}`, orgId,
    createdAt: now.toISOString(), updatedAt: now.toISOString()
  }));
}

type ConvRow = { id: string; orgId: string; channel: Channel; value: string; customerId: string | null; unread: number };
type MsgRow = ConversationMessage & { orgId: string; deliveryId: string | null; replyToken: string | null; providerMessageId: string | null };

type Suppression = {
  id: string; orgId: string; channel: Channel; value: string; reason: SuppressionReason; source: OptOutSource;
  customerId: string | null; createdAt: string;
};

/**
 * In-process store for local demos and tests. Data resets on restart. Mirrors the Postgres/RLS
 * semantics: every user-scoped call checks that the actor is a member of the org.
 */
export class MemoryStore implements OutreachStore {
  readonly kind = "memory" as const;
  private opps: Opportunity[] = buildSeedOpportunities();
  private convs: ConvRow[] = [];
  private msgs: MsgRow[] = [];
  constructor() { this.seedDemoMetricsOnce(seed.DEMO_ORG_ID); this.seedReplies(seed.DEMO_ORG_ID); }

  /** Demo threads and per-channel opt-outs (STOP reply, unsubscribe link, manual). */
  private seedReplies(orgId: string, now = Date.now()) {
    const byId = (id: string) => this.opps.find(o => o.orgId === orgId && o.customer.id === id)?.customer;
    for (const o of seed.optOuts) {
      const c = byId(o.customerId);
      const value = c && normalizeContact(o.channel, recipientFor(c, o.channel));
      if (!c || !value || this.suppressions.some(s => s.orgId === orgId && s.channel === o.channel && s.value === value)) continue;
      const createdAt = new Date(now - o.minutesAgo * 60_000).toISOString();
      this.suppressions.push({ id: randomUUID(), orgId, channel: o.channel, value, reason: "opt_out", source: o.source, customerId: c.id, createdAt });
      this.consent.push({ id: randomUUID(), orgId, channel: o.channel, value, event: "opt_out", source: o.source, actorId: null, requestId: null, createdAt });
    }
    if (this.convs.some(c => c.orgId === orgId)) return;
    for (const t of seed.threads) {
      const c = byId(t.customerId);
      const contact = c && recipientFor(c, t.channel);
      if (!contact) continue;
      let convId = "";
      for (const m of t.messages) {
        convId = this.appendSync(orgId, t.channel, contact, {
          direction: m.direction, kind: m.kind ?? "message", status: m.direction === "inbound" ? "received" : "sent",
          body: m.body, subject: m.subject ?? null, createdAt: new Date(now - m.minutesAgo * 60_000)
        }).conversationId;
      }
      if (t.read) this.convs.find(x => x.id === convId)!.unread = 0;
    }
  }
  private deliveries = new Map<string, Delivery>();
  private suppressions: Suppression[] = [];
  private aiUsage: Array<AiUsageRow & { orgId: string }> = [];
  /** orgId|oppId|channel → cached suggestion (served until fingerprint changes). */
  private suggestionCache = new Map<string, { cacheKey: string; suggestion: Suggestion }>();
  private sendLedger: Array<SendRow & { orgId: string }> = [];
  private demoPurchases: Array<PurchaseRow & { orgId: string }> = [];
  private smsCosts: Array<SmsCostRow & { orgId: string; updatedAt: string }> = [];
  private seededMetrics = new Set<string>();
  private seedDemoMetricsOnce(orgId: string) {
    if (this.seededMetrics.has(orgId)) return;
    this.seededMetrics.add(orgId);
    this.seedDemoMetrics(orgId);
  }
  private seedDemoMetrics(orgId: string) {
    const m = buildDemoMetrics();
    this.aiUsage.push(...m.usage.map(u => ({ ...u, orgId })));
    this.sendLedger.push(...m.sends.map(x => ({ ...x, orgId })));
    this.demoPurchases.push(...m.purchases.map(x => ({ ...x, orgId })));
    this.smsCosts.push(...m.smsCosts.map(x => ({ ...x, orgId, updatedAt: x.createdAt })));
  }
  private consent: Array<ConsentEvent & { orgId: string; value: string }> = [];
  private reoptins: Array<ReoptInRequest & { value: string; customerId: string | null; requestedBy: string }> = [];
  private recordConsent(orgId: string, channel: Channel, value: string, event: ConsentEvent["event"], source: ConsentEvent["source"], meta: ConsentMeta = {}) {
    this.consent.push({ id: randomUUID(), orgId, channel, value, event, source, actorId: meta.actorId ?? null, requestId: meta.requestId ?? null, createdAt: new Date().toISOString() });
  }
  private reoptStatus(r: ReoptInRequest, now = Date.now()): ReoptInRequest["status"] {
    return r.status === "pending" && Date.parse(r.expiresAt) <= now ? "expired" : r.status;
  }
  private memberships = new Map<string, Membership[]>([
    [seed.DEMO_USER_ID, [{ orgId: seed.DEMO_ORG_ID, orgName: seed.DEMO_ORG.name, businessName: seed.DEMO_ORG.businessName, role: "owner" }]]
  ]);
  readonly events: Array<{ orgId: string; opportunityId: string | null; actorId: string; type: string; details?: unknown }> = [];
  private emails = new Map<string, string>([[seed.DEMO_USER_ID, "demo@px-outreach.local"]]);
  private joined = new Map<string, Date>();
  private invitations: InvitationRow[] = [];
  private deals: Deal[] = buildSeedDeals();
  private settings = new Map<string, OrgSettings>([[seed.DEMO_ORG_ID, { ...seed.DEMO_SETTINGS }]]);

  /** Test helper: grant a user access to an org. */
  addMembership(userId: string, m: Membership, email?: string) {
    this.memberships.set(userId, [...(this.memberships.get(userId) ?? []), m]);
    if (email) this.emails.set(userId, email.toLowerCase());
  }

  private roleIn(userId: string, orgId: string): MemberRole | undefined {
    return this.memberships.get(userId)?.find(m => m.orgId === orgId)?.role;
  }
  private orgMeta(orgId: string) {
    for (const ms of this.memberships.values()) { const m = ms.find(x => x.orgId === orgId); if (m) return m; }
    return null;
  }
  private owners(orgId: string) {
    return [...this.memberships.entries()].filter(([, ms]) => ms.some(m => m.orgId === orgId && m.role === "owner")).map(([u]) => u);
  }
  private toInvitation(r: InvitationRow): Invitation {
    return {
      id: r.id, orgId: r.orgId, email: r.email, role: r.role, status: statusOf(r), invitedBy: r.invitedBy,
      createdAt: r.createdAt.toISOString(), expiresAt: r.expiresAt.toISOString(), lastSentAt: r.lastSentAt.toISOString(), sendCount: r.sendCount
    };
  }
  private audit(actor: Actor, type: string, details: unknown) {
    this.events.push({ orgId: actor.orgId, opportunityId: null, actorId: actor.userId, type, details });
  }

  private assertMember(actor: Actor) {
    if (!(this.memberships.get(actor.userId) ?? []).some(m => m.orgId === actor.orgId)) {
      throw new StoreError("forbidden", "Not a member of this organization");
    }
  }
  private find(actor: Actor, id: string) {
    this.assertMember(actor);
    return this.opps.find(o => o.orgId === actor.orgId && o.id === id) ?? null;
  }
  private isActionable(o: Opportunity) {
    return (ACTIONABLE_STATUSES as readonly string[]).includes(o.status);
  }
  private withSuppressions(o: Opportunity): Opportunity {
    const copy = structuredClone(o);
    copy.customer.suppressed = (["sms", "email"] as const).filter(ch => {
      const v = normalizeContact(ch, recipientFor(o.customer, ch));
      return v !== null && this.suppressions.some(s => s.orgId === o.orgId && s.channel === ch && s.value === v);
    });
    return copy;
  }

  async ping() {}
  async listMemberships(userId: string) { return structuredClone(this.memberships.get(userId) ?? []); }

  async listQueue(actor: Actor, limit: number, cooldown: Cooldowns = NO_COOLDOWN) {
    this.assertMember(actor);
    const now = Date.now();
    const all = this.opps.filter(o => o.orgId === actor.orgId && this.isActionable(o))
      .map(o => this.withSuppressions(o)).filter(o => inDeck(o.customer, cooldown, now));
    return { items: all.slice(0, limit), total: all.length };
  }
  async getOpportunity(actor: Actor, id: string) {
    const o = this.find(actor, id);
    return o ? this.withSuppressions(o) : null;
  }
  async skip(actor: Actor, id: string) {
    const o = this.find(actor, id);
    if (!o) throw new StoreError("not_found", "Opportunity not found");
    if (!this.isActionable(o)) throw new StoreError("conflict", `Opportunity already ${o.status}`);
    o.status = "skipped";
    this.events.push({ orgId: actor.orgId, opportunityId: id, actorId: actor.userId, type: "skipped" });
  }
  async saveSuggestion(actor: Actor, id: string, s: Suggestion) {
    const o = this.find(actor, id);
    if (!o) throw new StoreError("not_found", "Opportunity not found");
    if (o.status === "pending") o.status = "drafted";
    this.events.push({ orgId: actor.orgId, opportunityId: id, actorId: actor.userId, type: "draft_generated", details: { channel: s.channel, source: s.source } });
  }
  private cacheKeyOf(actor: Actor, id: string, channel: Channel) { return `${actor.orgId}|${id}|${channel}`; }
  async getCachedSuggestion(actor: Actor, id: string, channel: Channel, cacheKey: string) {
    this.assertMember(actor);
    const hit = this.suggestionCache.get(this.cacheKeyOf(actor, id, channel));
    return hit && hit.cacheKey === cacheKey ? structuredClone(hit.suggestion) : null;
  }
  async putCachedSuggestion(actor: Actor, id: string, channel: Channel, cacheKey: string, suggestion: Suggestion) {
    this.assertMember(actor);
    if (!this.find(actor, id)) throw new StoreError("not_found", "Opportunity not found");
    const { usage: _u, aiAttempt: _a, ...payload } = suggestion;
    this.suggestionCache.set(this.cacheKeyOf(actor, id, channel), { cacheKey, suggestion: structuredClone(payload) });
  }
  async createDelivery(actor: Actor, opportunityId: string, d: NewDelivery) {
    this.assertMember(actor);
    const existing = [...this.deliveries.values()].find(x => x.orgId === actor.orgId && x.idempotencyKey === d.idempotencyKey);
    if (existing) return { delivery: { ...existing }, duplicate: true };
    const o = this.find(actor, opportunityId);
    if (!o) throw new StoreError("not_found", "Opportunity not found");
    if (!this.isActionable(o)) throw new StoreError("conflict", `Opportunity already ${o.status}`);
    const value = normalizeContact(d.channel, d.recipient);
    if (this.suppressions.some(s => s.orgId === actor.orgId && s.channel === d.channel && s.value === value)) {
      throw new StoreError("suppressed", "Recipient has opted out of this channel");
    }
    const delivery: Delivery = {
      id: randomUUID(), orgId: actor.orgId, opportunityId, ...d, status: "queued",
      providerMessageId: null, error: null, createdAt: new Date().toISOString()
    };
    const rec = this.appendSync(actor.orgId, d.channel, d.recipient, {
      direction: "outbound", kind: "message", status: "queued", body: d.message, subject: d.subject, sentBy: actor.userId, deliveryId: delivery.id
    });
    delivery.replyToken = rec.replyToken;
    this.deliveries.set(delivery.id, delivery);
    o.status = "queued";
    this.events.push({ orgId: actor.orgId, opportunityId, actorId: actor.userId, type: "send_queued", details: { deliveryId: delivery.id } });
    return { delivery: { ...delivery }, duplicate: false };
  }
  async listDeliveries(actor: Actor, opportunityId: string) {
    this.assertMember(actor);
    return [...this.deliveries.values()].filter(d => d.orgId === actor.orgId && d.opportunityId === opportunityId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(d => ({ ...d }));
  }
  async optOut(actor: Actor, opportunityId: string, channels: Channel[], reason: SuppressionReason, meta?: ConsentMeta) {
    const o = this.find(actor, opportunityId);
    if (!o) throw new StoreError("not_found", "Opportunity not found");
    for (const channel of channels) {
      const value = normalizeContact(channel, recipientFor(o.customer, channel));
      if (value && !this.suppressions.some(s => s.orgId === actor.orgId && s.channel === channel && s.value === value)) {
        this.suppressions.push({ id: randomUUID(), orgId: actor.orgId, channel, value, reason, source: "manual", customerId: o.customer.id, createdAt: new Date().toISOString() });
        this.recordConsent(actor.orgId, channel, value, "opt_out", "manual", { actorId: actor.userId, requestId: meta?.requestId });
      }
    }
    if (this.isActionable(o)) o.status = "suppressed";
    this.events.push({ orgId: actor.orgId, opportunityId, actorId: actor.userId, type: "opted_out", details: { channels, reason } });
  }
  async metrics(actor: Actor): Promise<Metrics> {
    this.assertMember(actor);
    const count = <T>(xs: T[], key: (x: T) => string) => xs.reduce((m, x) => m.set(key(x), (m.get(key(x)) ?? 0) + 1), new Map<string, number>());
    const opps = count(this.opps.filter(o => o.orgId === actor.orgId), o => o.status);
    const dels = count([...this.deliveries.values()].filter(d => d.orgId === actor.orgId), d => `${d.status}|${d.channel}`);
    return {
      opportunities: [...opps].map(([status, n]) => ({ status, count: n })),
      deliveries: [...dels].map(([k, n]) => { const [status, channel] = k.split("|"); return { status, channel, count: n }; })
    };
  }
  async listDeals(actor: Actor) {
    this.assertMember(actor);
    return structuredClone(this.deals.filter(d => d.orgId === actor.orgId))
      .sort((a, b) => Math.min(...a.days) - Math.min(...b.days) || a.createdAt.localeCompare(b.createdAt));
  }
  async createDeal(actor: Actor, input: DealInput) {
    this.assertMember(actor);
    assertCanEditDeals(this.roleIn(actor.userId, actor.orgId));
    const now = new Date().toISOString();
    const deal: Deal = { ...structuredClone(input), id: randomUUID(), orgId: actor.orgId, createdAt: now, updatedAt: now };
    this.deals.push(deal);
    this.audit(actor, "deal_created", { dealId: deal.id });
    return structuredClone(deal);
  }
  async updateDeal(actor: Actor, id: string, input: DealInput) {
    this.assertMember(actor);
    assertCanEditDeals(this.roleIn(actor.userId, actor.orgId));
    const d = this.deals.find(x => x.orgId === actor.orgId && x.id === id);
    if (!d) throw new StoreError("not_found", "Deal not found");
    Object.assign(d, structuredClone(input), { updatedAt: new Date().toISOString() });
    this.audit(actor, "deal_updated", { dealId: id });
    return structuredClone(d);
  }
  async deleteDeal(actor: Actor, id: string) {
    this.assertMember(actor);
    assertCanEditDeals(this.roleIn(actor.userId, actor.orgId));
    const before = this.deals.length;
    this.deals = this.deals.filter(x => !(x.orgId === actor.orgId && x.id === id));
    if (this.deals.length === before) throw new StoreError("not_found", "Deal not found");
    this.audit(actor, "deal_deleted", { dealId: id });
  }
  async getSettings(actor: Actor) {
    this.assertMember(actor);
    return { ...(this.settings.get(actor.orgId) ?? DEFAULT_SETTINGS) };
  }
  async updateSettings(actor: Actor, next: OrgSettings) {
    this.assertMember(actor);
    assertCanEditDeals(this.roleIn(actor.userId, actor.orgId));
    this.settings.set(actor.orgId, { ...next });
    this.audit(actor, "settings_updated", {});
    return { ...next };
  }
  async listCatalog(actor: Actor): Promise<CatalogProduct[]> {
    this.assertMember(actor);
    return seed.products.map(p => ({ id: p.id, name: p.name, brand: p.brand, category: p.category, priceCents: p.priceCents }));
  }

  async reset(actor: Actor) {
    this.assertMember(actor);
    this.opps = [...this.opps.filter(o => o.orgId !== actor.orgId), ...buildSeedOpportunities(Date.now(), actor.orgId)];
    this.suppressions = this.suppressions.filter(s => s.orgId !== actor.orgId);
    this.consent = this.consent.filter(e => e.orgId !== actor.orgId);
    this.reoptins = this.reoptins.filter(r => r.orgId !== actor.orgId);
    if (actor.orgId === seed.DEMO_ORG_ID) this.seedReplies(actor.orgId);
    for (const k of [...this.suggestionCache.keys()]) if (k.startsWith(actor.orgId + "|")) this.suggestionCache.delete(k);
  }

  readonly systemEvents: Array<{ orgId: string; type: string; details: unknown }> = [];
  private customerFor(orgId: string, channel: Channel, value: string) {
    return this.opps.find(o => o.orgId === orgId && normalizeContact(channel, recipientFor(o.customer, channel)) === value)?.customer ?? null;
  }
  async recordAiUsage(actor: Actor, u: AiUsageInput) {
    this.assertMember(actor);
    this.aiUsage.push({ ...u, id: randomUUID(), orgId: actor.orgId, ledToSend: false, sentChannel: null, isDemo: false, createdAt: new Date().toISOString() });
  }
  async markAiUsageSent(actor: Actor, opportunityId: string, channel: Channel) {
    this.assertMember(actor);
    const u = this.aiUsage.filter(x => x.orgId === actor.orgId && x.opportunityId === opportunityId).at(-1);
    if (!u) return null;
    u.ledToSend = true; u.sentChannel = channel;
    return { model: u.model, dealId: u.dealId, dealTitle: u.dealTitle };
  }
  async listAiUsage(actor: Actor, sinceIso: string) {
    this.assertMember(actor);
    assertCanManageConsent(this.roleIn(actor.userId, actor.orgId), "view costs");
    return structuredClone(this.aiUsage.filter(u => u.orgId === actor.orgId && u.createdAt >= sinceIso)).map(({ orgId: _o, ...u }) => u);
  }
  async recordSmsCost(orgId: string, c: SmsCostInput) {
    const now = new Date().toISOString();
    this.smsCosts.push({ ...c, status: c.status ?? null, id: randomUUID(), orgId, isDemo: false, createdAt: now, updatedAt: now });
  }
  async updateSmsCost(messageSid: string, patch: { priceUsd?: number; segments?: number; status?: string }) {
    const row = this.smsCosts.find(x => x.messageSid === messageSid);
    if (!row) return false;
    if (patch.priceUsd !== undefined) { row.priceUsd = Math.abs(patch.priceUsd); row.estimated = false; }
    if (patch.segments) row.segments = patch.segments;
    if (patch.status) row.status = patch.status;
    row.updatedAt = new Date().toISOString();
    return true;
  }
  async listEstimatedSmsCosts(o: { olderThanIso: string; newerThanIso: string; limit: number }) {
    return this.smsCosts.filter(x => x.estimated && x.provider === "twilio" && x.messageSid && !x.isDemo && x.createdAt <= o.olderThanIso && x.createdAt >= o.newerThanIso)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, o.limit).map(x => ({ messageSid: x.messageSid! }));
  }
  async listSmsCosts(actor: Actor, sinceIso: string) {
    this.assertMember(actor);
    assertCanManageConsent(this.roleIn(actor.userId, actor.orgId), "view costs");
    return structuredClone(this.smsCosts.filter(x => x.orgId === actor.orgId && x.createdAt >= sinceIso)).map(({ orgId: _o, updatedAt: _u, ...x }) => x);
  }
  async recordSend(actor: Actor, s: SendInput) {
    this.assertMember(actor);
    this.sendLedger.push({ ...s, id: randomUUID(), orgId: actor.orgId, userId: actor.userId, isDemo: false, createdAt: new Date().toISOString() });
  }
  async listSends(actor: Actor, sinceIso: string) {
    this.assertMember(actor);
    return structuredClone(this.sendLedger.filter(x => x.orgId === actor.orgId && x.createdAt >= sinceIso)).map(({ orgId: _o, ...x }) => x);
  }
  async listPurchaseRows(actor: Actor, sinceIso: string) {
    this.assertMember(actor);
    const real: PurchaseRow[] = this.opps.filter(o => o.orgId === actor.orgId).flatMap(o => o.customer.purchases
      .filter(p => p.purchasedAt >= sinceIso)
      .map(p => ({ customerId: o.customer.id, purchaseId: `${o.customer.id}:${p.purchasedAt}`, purchasedAt: p.purchasedAt, priceCents: p.priceCents,
        category: p.category, productId: p.productId, isDemo: false })));
    const demo = this.demoPurchases.filter(x => x.orgId === actor.orgId && x.purchasedAt >= sinceIso).map(({ orgId: _o, ...x }) => x);
    return [...real, ...demo];
  }
  async listOptOuts(actor: Actor, q: { channel?: Channel; search?: string; limit: number; offset: number }) {
    this.assertMember(actor);
    const needle = q.search?.toLowerCase();
    const rows: OptOutEntry[] = this.suppressions
      .filter(s => s.orgId === actor.orgId && (!q.channel || s.channel === q.channel))
      .map(s => {
        const c = s.customerId ? this.opps.find(o => o.orgId === s.orgId && o.customer.id === s.customerId)?.customer ?? null : this.customerFor(s.orgId, s.channel, s.value);
        return { s, c };
      })
      .filter(({ s, c }) => !needle || s.value.toLowerCase().includes(needle) || (c && `${c.firstName} ${c.lastName}`.toLowerCase().includes(needle)))
      .sort((a, b) => b.s.createdAt.localeCompare(a.s.createdAt))
      .map(({ s, c }) => ({
        id: s.id, channel: s.channel, contact: maskRecipient(s.value), customerId: c?.id ?? null,
        customerName: c ? `${c.firstName} ${c.lastName}`.trim() : null, source: s.source, reason: s.reason, createdAt: s.createdAt,
        reoptIn: this.latestReopt(s.orgId, s.channel, s.value)
      }));
    return { items: rows.slice(q.offset, q.offset + q.limit), total: rows.length };
  }
  private latestReopt(orgId: string, channel: Channel, value: string): OptOutEntry["reoptIn"] {
    const r = this.reoptins.filter(x => x.orgId === orgId && x.channel === channel && x.value === value).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!r) return null;
    return { status: this.reoptStatus(r), requestedAt: r.createdAt, expiresAt: r.expiresAt,
      nextAllowedAt: new Date(Date.parse(r.createdAt) + REOPTIN_COOLDOWN_DAYS * 86_400_000).toISOString() };
  }
  async listConsentEvents(actor: Actor, optOutId: string): Promise<ConsentEvent[]> {
    this.assertMember(actor);
    const s = this.suppressions.find(x => x.orgId === actor.orgId && x.id === optOutId);
    if (!s) throw new StoreError("not_found", "Opt-out not found");
    return this.consent.filter(e => e.orgId === actor.orgId && e.channel === s.channel && e.value === s.value)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ orgId: _o, value: _v, ...e }) => structuredClone(e));
  }
  async createReoptInRequest(actor: Actor, optOutId: string, meta: ConsentMeta = {}, opts: { allowSms?: boolean } = {}) {
    this.assertMember(actor);
    assertCanManageConsent(this.roleIn(actor.userId, actor.orgId));
    const s = this.suppressions.find(x => x.orgId === actor.orgId && x.id === optOutId);
    if (!s) throw new StoreError("not_found", "Opt-out not found");
    if (s.channel === "sms" && !opts.allowSms) throw new StoreError("forbidden", "Texting a number that replied STOP is restricted. SMS re-opt-in requests are off (ALLOW_SMS_REOPTIN_REQUEST).", "sms_reoptin_disabled");
    if (s.reason !== "opt_out") throw new StoreError("conflict", "Bounced or complained addresses can't be asked to re-subscribe", "not_reoptinable");
    assertReoptAllowed(this.latestReopt(s.orgId, s.channel, s.value));
    const now = Date.now();
    const req = { id: randomUUID(), orgId: s.orgId, channel: s.channel, contact: s.value, value: s.value, customerId: s.customerId, requestedBy: actor.userId,
      status: "pending" as const, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + REOPTIN_COOLDOWN_DAYS * 86_400_000).toISOString() };
    this.reoptins.push(req);
    this.recordConsent(s.orgId, s.channel, s.value, "reoptin_requested", "store_request", { actorId: actor.userId, requestId: meta.requestId });
    const c = s.customerId ? this.opps.find(o => o.orgId === s.orgId && o.customer.id === s.customerId)?.customer : this.customerFor(s.orgId, s.channel, s.value);
    const { value: _v, customerId: _c, requestedBy: _r, ...request } = req;
    return { request: structuredClone(request), recipient: s.value, customerFirstName: c?.firstName ?? null };
  }
  async cancelReoptInRequest(actor: Actor, requestId: string) {
    this.reoptins = this.reoptins.filter(r => !(r.orgId === actor.orgId && r.id === requestId && r.status === "pending"));
  }
  async getReoptInRequest(id: string) {
    const r = this.reoptins.find(x => x.id === id);
    if (!r) return null;
    const { value: _v, customerId: _c, requestedBy: _r, ...req } = r;
    return { ...structuredClone(req), status: this.reoptStatus(r) };
  }
  async confirmReoptIn(id: string, meta: ConsentMeta = {}) {
    const r = this.reoptins.find(x => x.id === id);
    if (!r || this.reoptStatus(r) === "expired") return null;
    if (r.status === "confirmed") return { removed: false };
    return this.removeOptOut(r.orgId, r.channel, r.value, "reoptin_link", meta);
  }
  async addOptOut(orgId: string, channel: Channel, contact: string, source: OptOutSource, meta: ConsentMeta = {}) {
    const value = normalizeContact(channel, contact);
    if (!value || this.suppressions.some(s => s.orgId === orgId && s.channel === channel && s.value === value)) return { created: false };
    this.recordConsent(orgId, channel, value, "opt_out", source, meta);
    const customer = this.customerFor(orgId, channel, value);
    this.suppressions.push({ id: randomUUID(), orgId, channel, value, reason: "opt_out", source, customerId: customer?.id ?? null, createdAt: new Date().toISOString() });
    this.systemEvents.push({ orgId, type: "opted_out", details: { channel, source, customerId: customer?.id ?? null } });
    return { created: true };
  }
  async removeOptOut(orgId: string, channel: Channel, contact: string, source: OptInSource, meta: ConsentMeta = {}) {
    const value = normalizeContact(channel, contact);
    const before = this.suppressions.length;
    this.suppressions = this.suppressions.filter(s => !(s.orgId === orgId && s.channel === channel && s.value === value && s.reason === "opt_out"));
    const removed = this.suppressions.length < before;
    if (removed && value) {
      this.systemEvents.push({ orgId, type: "opted_in", details: { channel, source } });
      this.recordConsent(orgId, channel, value, "opt_in", source, meta);
      // Any pending re-opt-in request for this contact is now fulfilled (link click or START reply).
      for (const r of this.reoptins) if (r.orgId === orgId && r.channel === channel && r.value === value && r.status === "pending") r.status = "confirmed";
    }
    return { removed };
  }
  private appendSync(orgId: string, channel: Channel, contact: string, m: NewMessage) {
    const value = normalizeContact(channel, contact) ?? contact;
    let conv = this.convs.find(c => c.orgId === orgId && c.channel === channel && c.value === value);
    if (!conv) {
      conv = { id: randomUUID(), orgId, channel, value, customerId: this.customerFor(orgId, channel, value)?.id ?? null, unread: 0 };
      this.convs.push(conv);
    }
    const replyToken = m.direction === "outbound" && channel === "email" ? newReplyToken() : null;
    const row: MsgRow = {
      id: randomUUID(), conversationId: conv.id, orgId, direction: m.direction, kind: m.kind, status: m.status, body: m.body,
      subject: m.subject ?? null, sentBy: m.sentBy ?? null, createdAt: (m.createdAt ?? new Date()).toISOString(),
      deliveryId: m.deliveryId ?? null, replyToken, providerMessageId: m.providerMessageId ?? null
    };
    this.msgs.push(row);
    if (m.direction === "inbound") conv.unread += 1;
    return { conversationId: conv.id, messageId: row.id, replyToken };
  }
  private summary(c: ConvRow): ConversationSummary {
    const last = this.msgs.filter(m => m.conversationId === c.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)!;
    const cust = c.customerId ? this.opps.find(o => o.orgId === c.orgId && o.customer.id === c.customerId)?.customer : null;
    return {
      id: c.id, channel: c.channel, customerId: c.customerId, customerName: cust ? `${cust.firstName} ${cust.lastName}`.trim() : null,
      contact: maskRecipient(c.value), lastMessageAt: last.createdAt, lastMessagePreview: last.body.replace(/\s+/g, " ").slice(0, 140),
      lastDirection: last.direction, unreadCount: c.unread,
      optedOut: this.suppressions.some(s => s.orgId === c.orgId && s.channel === c.channel && s.value === c.value)
    };
  }
  private conv(actor: Actor, id: string) {
    this.assertMember(actor);
    return this.convs.find(c => c.orgId === actor.orgId && c.id === id) ?? null;
  }
  async listConversations(actor: Actor, limit: number) {
    this.assertMember(actor);
    return this.convs.filter(c => c.orgId === actor.orgId).map(c => this.summary(c))
      .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt)).slice(0, limit);
  }
  async unreadCount(actor: Actor) {
    this.assertMember(actor);
    return this.convs.filter(c => c.orgId === actor.orgId && c.unread > 0).length;
  }
  async getThread(actor: Actor, id: string) {
    const c = this.conv(actor, id);
    if (!c) return null;
    const messages = this.msgs.filter(m => m.conversationId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(({ orgId: _o, deliveryId: _d, replyToken: _r, providerMessageId: _p, ...m }) => m);
    return { conversation: this.summary(c), messages };
  }
  async markRead(actor: Actor, id: string) {
    const c = this.conv(actor, id);
    if (!c) throw new StoreError("not_found", "Conversation not found");
    c.unread = 0;
  }
  async createReply(actor: Actor, conversationId: string, msg: { body: string; subject: string | null }) {
    const c = this.conv(actor, conversationId);
    if (!c) throw new StoreError("not_found", "Conversation not found");
    if (this.suppressions.some(s => s.orgId === c.orgId && s.channel === c.channel && s.value === c.value)) {
      throw new StoreError("suppressed", `This customer opted out of ${c.channel === "sms" ? "text messages" : "email"}`);
    }
    const r = this.appendSync(c.orgId, c.channel, c.value, { direction: "outbound", kind: "message", status: "sending", body: msg.body, subject: msg.subject, sentBy: actor.userId });
    this.events.push({ orgId: actor.orgId, opportunityId: null, actorId: actor.userId, type: "reply_sent", details: { conversationId } });
    const { orgId: _o, deliveryId: _d, replyToken: _r, providerMessageId: _p, ...message } = this.msgs.find(m => m.id === r.messageId)!;
    return { message, channel: c.channel, recipient: c.value, replyToken: r.replyToken };
  }
  async appendMessage(orgId: string, channel: Channel, contact: string, m: NewMessage) {
    const r = this.appendSync(orgId, channel, contact, m);
    this.systemEvents.push({ orgId, type: m.direction === "inbound" ? "reply_received" : "message_logged", details: { conversationId: r.conversationId, kind: m.kind } });
    return r;
  }
  async findReplyToken(token: string) {
    const m = this.msgs.find(x => x.replyToken !== null && x.replyToken === token);
    const c = m && this.convs.find(x => x.id === m.conversationId);
    return c ? { orgId: c.orgId, channel: c.channel, contact: c.value } : null;
  }
  async getOutboundMessage(id: string) {
    const m = this.msgs.find(x => x.id === id && x.direction === "outbound");
    const c = m && this.convs.find(x => x.id === m.conversationId);
    return c ? { orgId: c.orgId, channel: c.channel, contact: c.value } : null;
  }
  async updateMessageStatus(id: string, status: "sent" | "failed", providerMessageId?: string | null) {
    const m = this.msgs.find(x => x.id === id);
    if (m) { m.status = status; if (providerMessageId) m.providerMessageId = providerMessageId; }
  }

  async orgDisplayName(orgId: string) {
    return this.settings.get(orgId)?.storeName ?? this.orgMeta(orgId)?.businessName ?? this.orgMeta(orgId)?.orgName ?? null;
  }

  async isSuppressed(orgId: string, channel: Channel, recipient: string) {
    const value = normalizeContact(channel, recipient);
    return this.suppressions.some(s => s.orgId === orgId && s.channel === channel && s.value === value);
  }
  async getDelivery(id: string) {
    const d = this.deliveries.get(id);
    return d ? { ...d } : null;
  }
  async updateDelivery(id: string, status: DeliveryStatus, patch: { providerMessageId?: string; error?: string } = {}) {
    const d = this.deliveries.get(id);
    if (!d) throw new StoreError("not_found", "Delivery not found");
    d.status = status;
    if (patch.providerMessageId) d.providerMessageId = patch.providerMessageId;
    if (patch.error) d.error = patch.error;
    const o = this.opps.find(x => x.orgId === d.orgId && x.id === d.opportunityId);
    if (o && (status === "sent" || status === "failed")) o.status = status;
    if (status === "sent") this.touchLastSent(d.orgId, o?.customer.id ?? null, d.channel, new Date().toISOString());
    for (const m of this.msgs) if (m.deliveryId === id && status !== "delivered") m.status = status === "sending" ? "sending" : status;
  }
  // ── Customers ──
  /** Customer id → when/how it was added (seed customers count as added at startup). */
  private customerMeta = new Map<string, { createdAt: string; source: string | null }>();
  private orgCustomers(orgId: string): Customer[] {
    const byId = new Map<string, Customer>();
    for (const o of this.opps) if (o.orgId === orgId && !byId.has(o.customer.id)) byId.set(o.customer.id, o.customer);
    return [...byId.values()];
  }
  async customerKeys(actor: Actor) {
    this.assertMember(actor);
    const keys = { externalIds: new Set<string>(), phones: new Set<string>(), emails: new Set<string>() };
    for (const c of this.orgCustomers(actor.orgId)) {
      if (c.externalId) keys.externalIds.add(c.externalId);
      const p = phoneKey(c.phone), e = emailKey(c.email);
      if (p) keys.phones.add(p);
      if (e) keys.emails.add(e);
    }
    return keys;
  }
  async importCustomers(actor: Actor, rows: ImportCustomer[], consent: ImportConsent) {
    this.assertMember(actor);
    assertCanEditDeals(this.roleIn(actor.userId, actor.orgId));
    const keys = await this.customerKeys(actor);
    let inserted = 0, existing = 0;
    const now = new Date().toISOString();
    for (const r of rows) {
      if (isExisting(r, keys)) { existing++; continue; }
      const id = `cust_${randomUUID()}`;
      const customer: Customer = {
        id, externalId: r.externalId ? `qv:${r.externalId}` : null, firstName: r.firstName, lastName: r.lastName, age: r.age, gender: null,
        location: r.location, storesShopped: r.location ? [r.location] : [], phone: r.phone, email: r.email,
        smsConsent: consent.smsConsent && !!r.phone, emailConsent: consent.emailConsent && !!r.email, suppressed: [],
        lifetimeSpendCents: r.lifetimeSpendCents, lastPurchaseAt: r.lastPurchaseAt, itemsPurchased: 0, purchases: [],
        ageVerified: consent.ageVerified, lastSmsAt: null, lastEmailAt: null, lifetimeOrders: r.lifetimeOrders,
        rewards: r.rewardsPoints !== null ? { member: true, points: r.rewardsPoints, joinedAt: r.customerSince } : null,
        profile: { favoriteCategories: [], favoriteBrands: [], visitsPerMonth: 0, avgBasketCents: 0, preferredDay: null, preferredTime: null }
      };
      this.opps.push(this.newOpp(actor.orgId, customer, IMPORT_RATIONALE));
      this.customerMeta.set(id, { createdAt: now, source: "csv" });
      for (const ch of ["sms", "email"] as const) {
        const v = normalizeContact(ch, ch === "sms" ? r.phone : r.email);
        if (v && (ch === "sms" ? customer.smsConsent : customer.emailConsent)) this.recordConsent(actor.orgId, ch, v, "opt_in", "import_signup", { actorId: actor.userId });
      }
      if (r.externalId) keys.externalIds.add(`qv:${r.externalId}`);
      if (phoneKey(r.phone)) keys.phones.add(phoneKey(r.phone)!);
      if (emailKey(r.email)) keys.emails.add(emailKey(r.email)!);
      inserted++;
    }
    this.audit(actor, "customers_imported", { inserted, existing });
    return { inserted, existing };
  }
  private newOpp(orgId: string, customer: Customer, rationale: string): Opportunity {
    return { id: `opp_${randomUUID()}`, orgId, status: "pending", campaign: { ...MANUAL_CAMPAIGN }, score: 50, rationale, offer: null, customer };
  }
  async listCustomers(actor: Actor, q: { search?: string; limit: number; offset: number }) {
    this.assertMember(actor);
    const term = q.search?.trim().toLowerCase() ?? "";
    const digits = term.replace(/\D/g, "");
    const match = (c: Customer) => !term || `${c.firstName} ${c.lastName}`.toLowerCase().includes(term)
      || (c.email ?? "").toLowerCase().includes(term) || (digits.length >= 3 && (c.phone ?? "").replace(/\D/g, "").includes(digits));
    const all = this.orgCustomers(actor.orgId).filter(match)
      .map(c => toSummary(c, this.customerMeta.get(c.id) ?? { createdAt: this.startedAt, source: "seed" }))
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt) || x.name.localeCompare(y.name));
    return { items: all.slice(q.offset, q.offset + q.limit), total: all.length };
  }
  async openCustomerCard(actor: Actor, customerId: string) {
    this.assertMember(actor);
    const mine = this.opps.filter(o => o.orgId === actor.orgId && o.customer.id === customerId);
    if (!mine.length) return null;
    const open = mine.find(o => this.isActionable(o));
    if (open) return open.id;
    const opp = this.newOpp(actor.orgId, mine[0].customer, PICK_RATIONALE);
    this.opps.push(opp);
    return opp.id;
  }
  private readonly startedAt = new Date().toISOString();

  /** Stamps the customer's last outreach send on this channel (every opportunity for that customer shares it). */
  // ── Order history import ──
  private orderIds = new Map<string, Set<string>>();
  private ordersOf(orgId: string) { let s = this.orderIds.get(orgId); if (!s) this.orderIds.set(orgId, s = new Set()); return s; }
  async existingOrderIds(actor: Actor, ids: string[]) {
    this.assertMember(actor);
    const have = this.ordersOf(actor.orgId);
    return new Set(ids.filter(id => have.has(id)));
  }
  private findCustomer(orgId: string, c: Order["customer"]): Customer | null {
    const p = phoneKey(c.phone), e = emailKey(c.email), x = c.externalId ? `qv:${c.externalId}` : null;
    const all = this.orgCustomers(orgId);
    return (x && all.find(k => k.externalId === x)) || (p && all.find(k => phoneKey(k.phone) === p)) || (e && all.find(k => emailKey(k.email) === e)) || null;
  }
  async importOrders(actor: Actor, orders: Order[]) {
    this.assertMember(actor);
    assertCanEditDeals(this.roleIn(actor.userId, actor.orgId));
    const have = this.ordersOf(actor.orgId);
    const r = { inserted: 0, existing: 0, customersCreated: 0, unlinked: 0 };
    for (const o of orders) {
      if (have.has(o.externalId)) { r.existing++; continue; }
      let c = this.findCustomer(actor.orgId, o.customer);
      if (!c) {
        if (!o.customer.phone && !o.customer.email) { r.unlinked++; continue; }
        const [first, last] = splitName(o.customer.name ?? undefined);
        await this.importCustomers(actor, [{ row: 0, externalId: o.customer.externalId, firstName: (first ?? "Customer").slice(0, 100), lastName: (last ?? "").slice(0, 100),
          phone: o.customer.phone, email: o.customer.email, location: null, age: null, lastPurchaseAt: null, lifetimeSpendCents: 0, rewardsPoints: null, lifetimeOrders: null, customerSince: null }], IN_STORE_SIGNUP);
        c = this.findCustomer(actor.orgId, o.customer)!;
        r.customersCreated++;
      }
      const items = o.items.map((i, j) => ({ productId: `item:${i.name.toLowerCase()}`, name: i.name, category: i.category?.toLowerCase() ?? null, brand: i.brand,
        priceCents: i.unitPriceCents, imageUrl: null, purchasedAt: new Date(Date.parse(o.at) - j).toISOString() }));
      for (const opp of this.opps) {
        if (opp.orgId !== actor.orgId || opp.customer.id !== c.id) continue;
        const cu = opp.customer;
        cu.purchases = [...items, ...cu.purchases].sort((a, b) => b.purchasedAt.localeCompare(a.purchasedAt));
        cu.itemsPurchased = cu.purchases.length;
        cu.lifetimeSpendCents += Math.max(0, o.totalCents);
        if (!cu.lastPurchaseAt || cu.lastPurchaseAt < o.at) cu.lastPurchaseAt = o.at;
        const cats = new Map<string, number>();
        for (const p of cu.purchases) if (p.category) cats.set(p.category, (cats.get(p.category) ?? 0) + 1);
        cu.profile.favoriteCategories = [...cats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
      }
      have.add(o.externalId);
      r.inserted++;
    }
    this.audit(actor, "orders_imported", r);
    return r;
  }

  private touchLastSent(orgId: string, customerId: string | null, channel: Channel, at: string) {
    if (!customerId) return;
    for (const x of this.opps) {
      if (x.orgId !== orgId || x.customer.id !== customerId) continue;
      if (channel === "sms") x.customer.lastSmsAt = at; else x.customer.lastEmailAt = at;
    }
  }
  async listMembers(actor: Actor): Promise<TeamMember[]> {
    this.assertMember(actor);
    const order = { owner: 0, admin: 1, staff: 2 };
    return [...this.memberships.entries()].flatMap(([userId, ms]) => ms.filter(m => m.orgId === actor.orgId).map(m => ({
      userId, email: this.emails.get(userId) ?? null, role: m.role, joinedAt: (this.joined.get(`${m.orgId}:${userId}`) ?? new Date(0)).toISOString()
    }))).sort((a, b) => order[a.role] - order[b.role] || (a.email ?? "").localeCompare(b.email ?? ""));
  }

  async listInvitations(actor: Actor) {
    this.assertMember(actor);
    assertCanManage(this.roleIn(actor.userId, actor.orgId));
    return this.invitations.filter(r => r.orgId === actor.orgId && isOpen(r))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map(r => this.toInvitation(r));
  }

  async createInvitation(actor: Actor, inv: NewInvitation) {
    this.assertMember(actor);
    assertCanGrant(this.roleIn(actor.userId, actor.orgId), inv.role);
    const email = inv.email.toLowerCase();
    const existingUser = [...this.emails.entries()].find(([, e]) => e === email)?.[0];
    if (existingUser && this.roleIn(existingUser, actor.orgId)) throw new StoreError("conflict", "That person is already a member", "already_member");
    const open = this.invitations.find(r => r.orgId === actor.orgId && r.email === email && isOpen(r));
    if (open) {
      if (statusOf(open) !== "expired") throw new StoreError("conflict", "An invitation is already pending for that email", "already_invited");
      open.revokedAt = new Date(); open.revokedBy = actor.userId;
    }
    const now = new Date();
    const row: InvitationRow = {
      id: randomUUID(), orgId: actor.orgId, email, role: inv.role, tokenHash: inv.tokenHash, invitedBy: actor.userId,
      createdAt: now, expiresAt: inv.expiresAt, lastSentAt: now, sendCount: 1, acceptedAt: null, acceptedBy: null, revokedAt: null, revokedBy: null
    };
    this.invitations.push(row);
    this.audit(actor, "invitation_created", { invitationId: row.id, email, role: inv.role });
    return this.toInvitation(row);
  }

  private openInvite(actor: Actor, id: string) {
    this.assertMember(actor);
    const role = this.roleIn(actor.userId, actor.orgId);
    assertCanManage(role);
    const r = this.invitations.find(x => x.id === id && x.orgId === actor.orgId && isOpen(x));
    if (!r) throw new StoreError("not_found", "Invitation not found");
    assertCanGrant(role, r.role);
    return r;
  }

  async refreshInvitation(actor: Actor, id: string, next: { tokenHash: string; expiresAt: Date; cooldownSeconds: number }) {
    const r = this.openInvite(actor, id);
    if (Date.now() - r.lastSentAt.getTime() < next.cooldownSeconds * 1000) {
      throw new StoreError("conflict", "This invitation was just sent. Try again in a minute.", "resend_cooldown");
    }
    Object.assign(r, { tokenHash: next.tokenHash, expiresAt: next.expiresAt, lastSentAt: new Date(), sendCount: r.sendCount + 1 });
    this.audit(actor, "invitation_resent", { invitationId: r.id, email: r.email, sendCount: r.sendCount });
    return this.toInvitation(r);
  }

  async revokeInvitation(actor: Actor, id: string) {
    const r = this.openInvite(actor, id);
    r.revokedAt = new Date(); r.revokedBy = actor.userId;
    this.audit(actor, "invitation_revoked", { invitationId: r.id, email: r.email });
  }

  async changeMemberRole(actor: Actor, userId: string, role: MemberRole) {
    this.assertMember(actor);
    const mine = this.roleIn(actor.userId, actor.orgId);
    const current = this.roleIn(userId, actor.orgId);
    if (!current) throw new StoreError("not_found", "Member not found");
    assertCanModify(mine, current);
    assertCanGrant(mine, role);
    if (current === role) return;
    if (current === "owner" && this.owners(actor.orgId).length <= 1) throw teamError("last_owner");
    this.memberships.get(userId)!.find(m => m.orgId === actor.orgId)!.role = role;
    this.audit(actor, "member_role_changed", { userId, from: current, to: role });
  }

  async removeMember(actor: Actor, userId: string) {
    this.assertMember(actor);
    const current = this.roleIn(userId, actor.orgId);
    if (!current) throw new StoreError("not_found", "Member not found");
    if (userId !== actor.userId) assertCanModify(this.roleIn(actor.userId, actor.orgId), current);
    if (current === "owner" && this.owners(actor.orgId).length <= 1) throw teamError("last_owner");
    this.memberships.set(userId, this.memberships.get(userId)!.filter(m => m.orgId !== actor.orgId));
    this.audit(actor, userId === actor.userId ? "member_left" : "member_removed", { userId, role: current });
  }

  async claimPendingInvitations(user: { id: string; email: string | null }) {
    const email = user.email?.trim().toLowerCase();
    if (!email) return 0;
    let n = 0;
    for (const r of this.invitations.filter(x => x.email === email && !x.acceptedAt && !x.revokedAt && x.expiresAt.getTime() > Date.now())) {
      if (!this.roleIn(user.id, r.orgId)) {
        const meta = this.orgMeta(r.orgId)!;
        this.addMembership(user.id, { orgId: r.orgId, orgName: meta.orgName, businessName: meta.businessName, role: r.role }, user.email ?? undefined);
        this.joined.set(`${r.orgId}:${user.id}`, new Date());
        n++;
      }
      r.acceptedAt = new Date(); r.acceptedBy = user.id;
      this.audit({ userId: user.id, orgId: r.orgId }, "invitation_accepted", { invitationId: r.id, role: r.role, via: "sign_in" });
    }
    return n;
  }

  async bootstrapOwner(user: { id: string; email: string | null; emailVerified?: boolean }, _orgName: string) {
    if (!user.email || !user.emailVerified) return false;
    if (this.roleIn(user.id, seed.DEMO_ORG_ID) === "owner") return true;
    const meta = this.orgMeta(seed.DEMO_ORG_ID)!;
    this.addMembership(user.id, { orgId: seed.DEMO_ORG_ID, orgName: meta.orgName, businessName: meta.businessName, role: "owner" }, user.email);
    this.joined.set(`${seed.DEMO_ORG_ID}:${user.id}`, new Date());
    this.audit({ userId: user.id, orgId: seed.DEMO_ORG_ID }, "bootstrap_owner_added", {});
    return true;
  }

  async acceptInvitation(user: { id: string; email: string | null }, tokenHash: string) {
    const r = this.invitations.find(x => x.tokenHash === tokenHash);
    if (!r) throw teamError("invitation_invalid");
    if (r.revokedAt) throw teamError("invitation_revoked");
    if (r.acceptedAt) {
      if (r.acceptedBy === user.id) return { orgId: r.orgId, role: this.roleIn(user.id, r.orgId) ?? r.role, alreadyMember: true };
      throw teamError("invitation_used");
    }
    if (r.expiresAt.getTime() <= Date.now()) throw teamError("invitation_expired");
    if (!user.email || user.email.toLowerCase() !== r.email) throw teamError("invitation_email_mismatch");
    const existing = this.roleIn(user.id, r.orgId);
    if (!existing) {
      const meta = this.orgMeta(r.orgId)!;
      this.addMembership(user.id, { orgId: r.orgId, orgName: meta.orgName, businessName: meta.businessName, role: r.role }, user.email);
      this.joined.set(`${r.orgId}:${user.id}`, new Date());
    }
    r.acceptedAt = new Date(); r.acceptedBy = user.id;
    this.audit({ userId: user.id, orgId: r.orgId }, "invitation_accepted", { invitationId: r.id, role: existing ?? r.role, alreadyMember: !!existing });
    return { orgId: r.orgId, role: existing ?? r.role, alreadyMember: !!existing };
  }

  async previewInvitation(tokenHash: string): Promise<InvitationPreview | null> {
    const r = this.invitations.find(x => x.tokenHash === tokenHash);
    if (!r) return null;
    return { orgName: this.orgMeta(r.orgId)?.orgName ?? "", email: r.email, role: r.role, status: statusOf(r), expiresAt: r.expiresAt.toISOString() };
  }

  /** Test helper: move an invitation's clock. */
  _patchInvitation(id: string, patch: Partial<Pick<InvitationRow, "expiresAt" | "lastSentAt">>) {
    Object.assign(this.invitations.find(r => r.id === id)!, patch);
  }

  async close() {}
}
