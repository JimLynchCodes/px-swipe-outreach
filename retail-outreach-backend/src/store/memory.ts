import { randomUUID } from "node:crypto";
import * as seed from "../data/seed.js";
import { daysSince, ACTIONABLE_STATUSES, normalizeContact, recipientFor } from "../domain.js";
import type {
  Actor, Channel, Customer, Delivery, DeliveryStatus, Invitation, InvitationPreview, Membership, MemberRole, Metrics,
  Opportunity, Suggestion, SuppressionReason, TeamMember
} from "../types.js";
import { assertCanGrant, assertCanManage, assertCanModify } from "../team/policy.js";
import { StoreError, teamError, type NewDelivery, type NewInvitation, type OutreachStore } from "./types.js";

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
  readonly events: Array<{ orgId: string; opportunityId: string | null; actorId: string; type: string; details?: unknown }> = [];
  private emails = new Map<string, string>([[seed.DEMO_USER_ID, "demo@px-outreach.local"]]);
  private joined = new Map<string, Date>();
  private invitations: InvitationRow[] = [];

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
