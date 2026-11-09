import { DEFAULT_AI_MODEL } from "../ai/models.js";
import type {
  Actor, CatalogProduct, Channel, ConversationMessage, ConversationSummary, Deal, DealInput, NewMessage, OptOutEntry, OptOutSource, ConsentEvent, ConsentMeta, OptInSource, ReoptInRequest, OrgSettings, Delivery, DeliveryStatus, Invitation, InvitationPreview, Membership, MemberRole, Metrics, Opportunity,
  Suggestion, SuppressionReason, TeamMember, CustomerSummary
} from "../types.js";

export type StoreErrorCode = "not_found" | "conflict" | "suppressed" | "forbidden" | "gone" | "rate_limited";

export class StoreError extends Error {
  /** `reason` is a more specific machine-readable code returned to clients (e.g. "last_owner"). */
  constructor(public code: StoreErrorCode, message: string, public reason?: string) { super(message); this.name = "StoreError"; }
}

/** Maps invitation/membership database exceptions to StoreErrors. */
export const TEAM_ERRORS: Record<string, [StoreErrorCode, string]> = {
  last_owner: ["conflict", "An organization must keep at least one owner. Promote someone else to owner first."],
  invitation_invalid: ["not_found", "This invitation link is invalid."],
  invitation_revoked: ["gone", "This invitation was revoked. Ask for a new one."],
  invitation_used: ["gone", "This invitation has already been used."],
  invitation_expired: ["gone", "This invitation has expired. Ask for a new one."],
  invitation_email_mismatch: ["forbidden", "This invitation was sent to a different email address. Sign in with that address to accept it."]
};
export function teamError(reason: keyof typeof TEAM_ERRORS): StoreError {
  const [code, msg] = TEAM_ERRORS[reason];
  return new StoreError(code, msg, reason);
}

/** Per-channel cooldown windows in days (0 = off). Customers with no channel outside its window are left out of the queue. */
export type Cooldowns = { sms: number; email: number };

export type NewInvitation = { email: string; role: MemberRole; tokenHash: string; expiresAt: Date };

export type NewDelivery = {
  channel: Channel;
  recipient: string;
  message: string;
  subject: string | null;
  idempotencyKey: string;
};

/**
 * Persistence boundary. `MemoryStore` (demo) and `PostgresStore` (Supabase) implement the same contract.
 *
 * Methods taking an `Actor` are user-scoped: the Postgres implementation runs them inside a transaction
 * with `role authenticated` and the user's JWT claims, so Supabase row-level security applies in addition
 * to the explicit org filter. Methods without an Actor are system operations (delivery worker, health).
 */
export interface OutreachStore {
  readonly kind: "memory" | "postgres";
  /** Throws if the backing store is unreachable (readiness probe). */
  ping(): Promise<void>;
  /** Organizations the user belongs to. */
  listMemberships(userId: string): Promise<Membership[]>;

  /** Actionable (pending/drafted) opportunities, oldest first. */
  listQueue(actor: Actor, limit: number, cooldown?: Cooldowns): Promise<{ items: Opportunity[]; total: number }>;
  getOpportunity(actor: Actor, id: string): Promise<Opportunity | null>;
  /** Throws StoreError(not_found|conflict). */
  skip(actor: Actor, id: string): Promise<void>;
  saveSuggestion(actor: Actor, id: string, suggestion: Suggestion): Promise<void>;
  /** Latest cached suggestion for this card+channel when `cacheKey` still matches; null = miss (generate). */
  getCachedSuggestion(actor: Actor, id: string, channel: Channel, cacheKey: string): Promise<Suggestion | null>;
  /** Upsert the served suggestion under the current fingerprint (demo: memory; Supabase: suggestion_cache). */
  putCachedSuggestion(actor: Actor, id: string, channel: Channel, cacheKey: string, suggestion: Suggestion): Promise<void>;
  /**
   * Atomically moves the opportunity to `queued` and records a delivery.
   * Idempotent per (org, idempotencyKey): a repeat returns the existing delivery with duplicate=true.
   * Throws StoreError(suppressed) when the recipient is on the do-not-contact list.
   */
  createDelivery(actor: Actor, opportunityId: string, d: NewDelivery): Promise<{ delivery: Delivery; duplicate: boolean }>;
  listDeliveries(actor: Actor, opportunityId: string): Promise<Delivery[]>;
  /** Adds the customer's contact value(s) to the suppression list and marks the opportunity suppressed. */
  optOut(actor: Actor, opportunityId: string, channels: Channel[], reason: SuppressionReason, meta?: ConsentMeta): Promise<void>;
  metrics(actor: Actor): Promise<Metrics>;
  /** Demo helper: put every opportunity back to pending and clear suppressions. */
  reset(actor: Actor): Promise<void>;

  // ── Weekly deals. Members read; owners/admins write (enforced here and by RLS). ──
  listDeals(actor: Actor): Promise<Deal[]>;
  createDeal(actor: Actor, input: DealInput): Promise<Deal>;
  /** Throws not_found. */
  updateDeal(actor: Actor, id: string, input: DealInput): Promise<Deal>;
  /** Throws not_found. */
  deleteDeal(actor: Actor, id: string): Promise<void>;
  /** Products deals can target. */
  listCatalog(actor: Actor): Promise<CatalogProduct[]>;

  /** Paged opt-out list, newest first. `search` matches customer name or contact. */
  /** Consent history (opt-outs, re-opt-ins, re-opt-in requests) for the contact behind an opt-out entry. */
  listConsentEvents(actor: Actor, optOutId: string): Promise<ConsentEvent[]>;
  /**
   * Owner/admin only. Records a re-opt-in request for an opted-out contact and returns the raw recipient so the caller can
   * send exactly one message. Throws rate_limited (one per customer+channel per 30 days) or conflict (already pending).
   */
  createReoptInRequest(actor: Actor, optOutId: string, meta?: ConsentMeta, opts?: { allowSms?: boolean }): Promise<{ request: ReoptInRequest; recipient: string; customerFirstName: string | null }>;
  /** Marks a request failed-to-send (so it doesn't block a retry). */
  cancelReoptInRequest(actor: Actor, requestId: string): Promise<void>;
  // ── Metrics ──
  /** Records one suggestion call (any member, as themselves). */
  recordAiUsage(actor: Actor, u: import("../metrics/types.js").AiUsageInput): Promise<void>;
  /** Marks the latest suggestion for an opportunity as sent; returns its model/deal (null if none recorded). */
  markAiUsageSent(actor: Actor, opportunityId: string, channel: Channel): Promise<{ model: string; dealId: string | null; dealTitle: string | null } | null>;
  /** Owner/admin only. */
  listAiUsage(actor: Actor, sinceIso: string): Promise<import("../metrics/types.js").AiUsageRow[]>;
  recordSend(actor: Actor, s: import("../metrics/types.js").SendInput): Promise<void>;
  listSends(actor: Actor, sinceIso: string): Promise<import("../metrics/types.js").SendRow[]>;
  /** System (no actor): one row per outbound SMS, written by the send path. */
  recordSmsCost(orgId: string, c: import("../metrics/types.js").SmsCostInput): Promise<void>;
  /** System: apply Twilio's actual price/status (status callback or reconcile). No-op for unknown SIDs. */
  updateSmsCost(messageSid: string, patch: { priceUsd?: number; segments?: number; status?: string }): Promise<boolean>;
  /** System: Twilio rows still on an estimate, created between the two times (oldest first). */
  listEstimatedSmsCosts(opts: { olderThanIso: string; newerThanIso: string; limit: number }): Promise<Array<{ messageSid: string }>>;
  /** Owner/admin. */
  listSmsCosts(actor: Actor, sinceIso: string): Promise<import("../metrics/types.js").SmsCostRow[]>;
  listPurchaseRows(actor: Actor, sinceIso: string): Promise<import("../metrics/types.js").PurchaseRow[]>;
  listOptOuts(actor: Actor, q: { channel?: Channel; search?: string; limit: number; offset: number }): Promise<{ items: OptOutEntry[]; total: number }>;

  // ── Replies (conversations). Members read, mark read and reply. ──
  listConversations(actor: Actor, limit: number): Promise<ConversationSummary[]>;
  /** Number of conversations with unread inbound messages. */
  unreadCount(actor: Actor): Promise<number>;
  getThread(actor: Actor, id: string): Promise<{ conversation: ConversationSummary; messages: ConversationMessage[] } | null>;
  markRead(actor: Actor, id: string): Promise<void>;
  /**
   * Records an outbound reply (status "sending") and returns what the route needs to send it.
   * Throws not_found, suppressed (customer opted out of this channel).
   */
  createReply(actor: Actor, conversationId: string, msg: { body: string; subject: string | null }):
    Promise<{ message: ConversationMessage; channel: Channel; recipient: string; replyToken: string | null }>;

  /** Org settings (defaults when never saved). Members read; owners/admins write. */
  getSettings(actor: Actor): Promise<OrgSettings>;
  updateSettings(actor: Actor, settings: OrgSettings): Promise<OrgSettings>;

  // ── Team management. Mutations require owner/admin (enforced here and by RLS). ──
  listMembers(actor: Actor): Promise<TeamMember[]>;
  listInvitations(actor: Actor): Promise<Invitation[]>;
  /** Throws conflict(already_member | already_invited), forbidden. */
  createInvitation(actor: Actor, inv: NewInvitation): Promise<Invitation>;
  /** Rotates the token and extends expiry of a pending invitation. Throws conflict(resend_cooldown). */
  refreshInvitation(actor: Actor, id: string, next: { tokenHash: string; expiresAt: Date; cooldownSeconds: number }): Promise<Invitation>;
  revokeInvitation(actor: Actor, id: string): Promise<void>;
  /** Throws conflict(last_owner), forbidden. */
  changeMemberRole(actor: Actor, userId: string, role: MemberRole): Promise<void>;
  /** Removes a member (or the actor leaving). Throws conflict(last_owner). */
  removeMember(actor: Actor, userId: string): Promise<void>;
  /** Accepts as the signed-in user; their verified email must match. */
  /** Auto-joins the user to every org with an unexpired pending invite for their email (case-insensitive). Returns orgs joined. */
  claimPendingInvitations(user: { id: string; email: string | null }): Promise<number>;
  /** Approve a configured bootstrap owner (see BOOTSTRAP_OWNER_EMAILS): owner of the default org. True when added. */
  bootstrapOwner(user: { id: string; email: string | null; emailVerified?: boolean }, orgName: string): Promise<boolean>;
  acceptInvitation(user: { id: string; email: string | null }, tokenHash: string): Promise<{ orgId: string; role: MemberRole; alreadyMember: boolean }>;

  // ── Customers (Registered users + CSV import) ──
  /** Dedupe keys of every customer in the org: `qv:` external ids, phone last-10 digits, lowercased emails. */
  customerKeys(actor: Actor): Promise<import("../customers/csvImport.js").ExistingKeys>;
  /**
   * Owner/admin. Inserts the customers that still don't match an existing one (re-checked inside the transaction) and gives
   * each a pending opportunity so they reach the deck. Returns how many were inserted and how many turned out to exist.
   */
  importCustomers(actor: Actor, rows: import("../customers/csvImport.js").ImportCustomer[], consent: import("../customers/csvImport.js").ImportConsent, onProgress?: (done: number, total: number) => void): Promise<{ inserted: number; existing: number }>;
  /** Newest first. `search` matches name, phone digits or email. */
  listCustomers(actor: Actor, q: { search?: string; limit: number; offset: number }): Promise<{ items: CustomerSummary[]; total: number }>;
  /** Any member. The customer's actionable opportunity, creating a pending one if needed (explicit pick from Registered users). Null = unknown customer. Throws forbidden(no_marketing_consent) when they have no reachable opted-in channel. */
  openCustomerCard(actor: Actor, customerId: string): Promise<string | null>;

  /** Which of these order ids (POS ids, without the `qv:` prefix) are already in purchase history. */
  existingOrderIds(actor: Actor, orderIds: string[]): Promise<Set<string>>;
  /**
   * Owner/admin. Adds orders not already in purchase history (deduped by order id inside the transaction) to the same
   * purchases/purchase_items tables the Quickvee sync uses. Links each to its customer (POS id → phone → email), creating
   * missing customers (in-store signup consent, like the customer import); walk-ins with no contact are skipped as unlinked.
   * Buying profiles are recomputed for every touched customer.
   */
  importOrders(actor: Actor, orders: import("../sync/types.js").Order[], onProgress?: (done: number, total: number) => void): Promise<{ inserted: number; existing: number; customersCreated: number; unlinked: number }>;

  // System operations (no user context).
  /** Idempotent per (org, channel, contact). Audited. Returns created=false when already opted out. */
  addOptOut(orgId: string, channel: Channel, contact: string, source: OptOutSource, meta?: ConsentMeta): Promise<{ created: boolean }>;
  /** Re-subscribe (e.g. SMS START): removes only opt-outs (never bounces/complaints). Audited. */
  removeOptOut(orgId: string, channel: Channel, contact: string, source: OptInSource, meta?: ConsentMeta): Promise<{ removed: boolean }>;
  /** Re-opt-in request by id (system: used by the public confirm link). Expired pending requests report "expired". */
  getReoptInRequest(id: string): Promise<ReoptInRequest | null>;
  /** Customer confirmed a re-opt-in request: removes the opt-out, marks the request confirmed. Idempotent. */
  confirmReoptIn(id: string, meta?: ConsentMeta): Promise<{ removed: boolean } | null>;
  /** Appends to the (org, channel, contact) thread, creating it if needed; inbound messages count as unread. */
  appendMessage(orgId: string, channel: Channel, contact: string, msg: NewMessage): Promise<{ conversationId: string; messageId: string; replyToken: string | null }>;
  /** Resolves a reply-to token from an outbound email. */
  findReplyToken(token: string): Promise<{ orgId: string; channel: Channel; contact: string } | null>;
  /** Org/contact of an outbound message (for unsubscribe links on replies). */
  getOutboundMessage(id: string): Promise<{ orgId: string; channel: Channel; contact: string } | null>;
  updateMessageStatus(id: string, status: "sent" | "failed", providerMessageId?: string | null): Promise<void>;
  /** Store name used in customer-facing replies (settings → business name → org name). */
  orgDisplayName(orgId: string): Promise<string | null>;
  /** Public accept-page details for a token holder; null when unknown. */
  previewInvitation(tokenHash: string): Promise<InvitationPreview | null>;
  /** True when the org's suppression list blocks this recipient (re-checked right before sending). */
  isSuppressed(orgId: string, channel: Channel, recipient: string): Promise<boolean>;
  getDelivery(id: string): Promise<Delivery | null>;
  updateDelivery(id: string, status: DeliveryStatus, patch?: { providerMessageId?: string; error?: string }): Promise<void>;
  close(): Promise<void>;
}

export const DEFAULT_SETTINGS: OrgSettings = { storeName: null, emailSignature: "", smsSignature: "", defaultChannel: null, maxDiscountPercent: 25, aiModel: DEFAULT_AI_MODEL,
  brandVoice: { preset: "friendly", emoji: false, signOff: "", about: "" }, smsCooldownDays: 0, emailCooldownDays: 0 };
