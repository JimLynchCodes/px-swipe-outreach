import { randomUUID } from "node:crypto";
import * as seed from "../data/seed.js";
import { daysSince, ACTIONABLE_STATUSES } from "../domain.js";
import type { Customer, Delivery, DeliveryStatus, Metrics, Opportunity, Suggestion } from "../types.js";
import { StoreError, type NewDelivery, type OutreachStore } from "./types.js";

const DAY_MS = 86_400_000;

export function buildSeedOpportunities(now = Date.now()): Opportunity[] {
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
      smsConsent: sc.smsConsent, emailConsent: sc.emailConsent, optedOut: false,
      lifetimeSpendCents: seed.lifetimeSpend(sc),
      lastPurchaseAt: purchases[0]?.purchasedAt ?? null,
      itemsPurchased: purchases.length,
      purchases
    };
    const pick = seed.chooseCampaign(daysSince(customer.lastPurchaseAt, now) ?? 9999, customer.lifetimeSpendCents);
    const campaign = seed.campaigns.find(x => x.id === pick.campaignId)!;
    return {
      id: `opp_${String(i + 1).padStart(4, "0")}`,
      tenantId: seed.DEMO_TENANT,
      status: "pending",
      campaign: { ...campaign },
      score: pick.score,
      rationale: pick.rationale,
      offer: seed.offers.find(o => o.id === pick.offerId) ?? null,
      customer
    };
  });
}

export class MemoryStore implements OutreachStore {
  private opps: Opportunity[] = buildSeedOpportunities();
  private deliveries = new Map<string, Delivery>();
  readonly events: Array<{ tenantId: string; opportunityId: string; actorId: string; type: string; details?: unknown }> = [];

  private find(tenantId: string, id: string) {
    return this.opps.find(o => o.tenantId === tenantId && o.id === id) ?? null;
  }
  private isActionable(o: Opportunity) {
    return (ACTIONABLE_STATUSES as readonly string[]).includes(o.status);
  }

  async listQueue(tenantId: string, limit: number) {
    const all = this.opps.filter(o => o.tenantId === tenantId && this.isActionable(o));
    return { items: structuredClone(all.slice(0, limit)), total: all.length };
  }
  async getOpportunity(tenantId: string, id: string) {
    const o = this.find(tenantId, id);
    return o ? structuredClone(o) : null;
  }
  async skip(tenantId: string, id: string, actorId: string) {
    const o = this.find(tenantId, id);
    if (!o) throw new StoreError("not_found", "Opportunity not found");
    if (!this.isActionable(o)) throw new StoreError("conflict", `Opportunity already ${o.status}`);
    o.status = "skipped";
    this.events.push({ tenantId, opportunityId: id, actorId, type: "skipped" });
  }
  async saveSuggestion(tenantId: string, id: string, actorId: string, s: Suggestion) {
    const o = this.find(tenantId, id);
    if (!o) throw new StoreError("not_found", "Opportunity not found");
    if (o.status === "pending") o.status = "drafted";
    this.events.push({ tenantId, opportunityId: id, actorId, type: "draft_generated", details: { channel: s.channel, source: s.source } });
  }
  async createDelivery(tenantId: string, opportunityId: string, actorId: string, d: NewDelivery) {
    const existing = [...this.deliveries.values()].find(x => x.tenantId === tenantId && x.idempotencyKey === d.idempotencyKey);
    if (existing) return { delivery: { ...existing }, duplicate: true };
    const o = this.find(tenantId, opportunityId);
    if (!o) throw new StoreError("not_found", "Opportunity not found");
    if (!this.isActionable(o)) throw new StoreError("conflict", `Opportunity already ${o.status}`);
    const delivery: Delivery = {
      id: randomUUID(), tenantId, opportunityId, ...d, status: "queued",
      providerMessageId: null, error: null, createdAt: new Date().toISOString()
    };
    this.deliveries.set(delivery.id, delivery);
    o.status = "queued";
    this.events.push({ tenantId, opportunityId, actorId, type: "send_queued", details: { deliveryId: delivery.id } });
    return { delivery: { ...delivery }, duplicate: false };
  }
  async getDelivery(id: string) {
    const d = this.deliveries.get(id);
    return d ? { ...d } : null;
  }
  async listDeliveries(tenantId: string, opportunityId: string) {
    return [...this.deliveries.values()].filter(d => d.tenantId === tenantId && d.opportunityId === opportunityId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(d => ({ ...d }));
  }
  async updateDelivery(id: string, status: DeliveryStatus, patch: { providerMessageId?: string; error?: string } = {}) {
    const d = this.deliveries.get(id);
    if (!d) throw new StoreError("not_found", "Delivery not found");
    d.status = status;
    if (patch.providerMessageId) d.providerMessageId = patch.providerMessageId;
    if (patch.error) d.error = patch.error;
    const o = this.find(d.tenantId, d.opportunityId);
    if (o && (status === "sent" || status === "failed")) o.status = status;
  }
  async metrics(tenantId: string): Promise<Metrics> {
    const count = <T>(xs: T[], key: (x: T) => string) => xs.reduce((m, x) => m.set(key(x), (m.get(key(x)) ?? 0) + 1), new Map<string, number>());
    const opps = count(this.opps.filter(o => o.tenantId === tenantId), o => o.status);
    const dels = count([...this.deliveries.values()].filter(d => d.tenantId === tenantId), d => `${d.status}|${d.channel}`);
    return {
      opportunities: [...opps].map(([status, n]) => ({ status, count: n })),
      deliveries: [...dels].map(([k, n]) => { const [status, channel] = k.split("|"); return { status, channel, count: n }; })
    };
  }
  async reset(tenantId: string) {
    this.opps = [...this.opps.filter(o => o.tenantId !== tenantId), ...buildSeedOpportunities().filter(o => o.tenantId === tenantId)];
  }
  async close() {}
}
