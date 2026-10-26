import { randomUUID } from "node:crypto";
import * as seed from "../data/seed.js";
import { daysSince, ACTIONABLE_STATUSES, normalizeContact, recipientFor } from "../domain.js";
import type {
  Actor, Channel, Customer, Delivery, DeliveryStatus, Membership, Metrics, Opportunity, Suggestion, SuppressionReason
} from "../types.js";
import { StoreError, type NewDelivery, type OutreachStore } from "./types.js";

const DAY_MS = 86_400_000;

export function buildSeedOpportunities(now = Date.now(), orgId = seed.DEMO_ORG_ID): Opportunity[] {
  return seed.customers.map((sc, i) => {
    const purchases = sc.purchases.map(([pid, daysAgo]) => {
      const p = seed.productById(pid);
      return {
        productId: p.id, name: p.name, category: p.category, priceCents: p.priceCents,
        imageUrl: p.imageUrl, purchasedAt: new Date(now - daysAgo * DAY_MS).toISOString()
      };
    });
    const customer: Customer = {
      id: sc.id, firstName: sc.firstName, lastName: sc.lastName, age: sc.age, gender: sc.gender,
      location: sc.location, storesShopped: sc.storesShopped, phone: sc.phone, email: sc.email,
      smsConsent: sc.smsConsent, emailConsent: sc.emailConsent, suppressed: [],
      lifetimeSpendCents: seed.lifetimeSpend(sc),
      lastPurchaseAt: purchases[0]?.purchasedAt ?? null,
      itemsPurchased: purchases.length,
      purchases
    };
    const pick = seed.chooseCampaign(daysSince(customer.lastPurchaseAt, now) ?? 9999, customer.lifetimeSpendCents);
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

type Suppression = { orgId: string; channel: Channel; value: string; reason: SuppressionReason };

/**
 * In-process store for local demos and tests. Data resets on restart. Mirrors the Postgres/RLS
 * semantics: every user-scoped call checks that the actor is a member of the org.
 */
export class MemoryStore implements OutreachStore {
  readonly kind = "memory" as const;
  private opps: Opportunity[] = buildSeedOpportunities();
  private deliveries = new Map<string, Delivery>();
  private suppressions: Suppression[] = [];
  private memberships = new Map<string, Membership[]>([
    [seed.DEMO_USER_ID, [{ orgId: seed.DEMO_ORG_ID, orgName: seed.DEMO_ORG.name, businessName: seed.DEMO_ORG.businessName, role: "owner" }]]
  ]);
  readonly events: Array<{ orgId: string; opportunityId: string; actorId: string; type: string; details?: unknown }> = [];

  /** Test helper: grant a user access to an org. */
  addMembership(userId: string, m: Membership) {
    this.memberships.set(userId, [...(this.memberships.get(userId) ?? []), m]);
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

  async listQueue(actor: Actor, limit: number) {
    this.assertMember(actor);
    const all = this.opps.filter(o => o.orgId === actor.orgId && this.isActionable(o));
    return { items: all.slice(0, limit).map(o => this.withSuppressions(o)), total: all.length };
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
  async optOut(actor: Actor, opportunityId: string, channels: Channel[], reason: SuppressionReason) {
    const o = this.find(actor, opportunityId);
    if (!o) throw new StoreError("not_found", "Opportunity not found");
    for (const channel of channels) {
      const value = normalizeContact(channel, recipientFor(o.customer, channel));
      if (value && !this.suppressions.some(s => s.orgId === actor.orgId && s.channel === channel && s.value === value)) {
        this.suppressions.push({ orgId: actor.orgId, channel, value, reason });
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
  async reset(actor: Actor) {
    this.assertMember(actor);
    this.opps = [...this.opps.filter(o => o.orgId !== actor.orgId), ...buildSeedOpportunities(Date.now(), actor.orgId)];
    this.suppressions = this.suppressions.filter(s => s.orgId !== actor.orgId);
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
  }
  async close() {}
}
