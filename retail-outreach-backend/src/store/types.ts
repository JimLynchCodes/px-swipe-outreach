import { DEFAULT_AI_MODEL } from "../ai/models.js";
import type {
  Actor, CatalogProduct, Channel, ConversationMessage, ConversationSummary, Deal, DealInput, NewMessage, OptOutEntry, OptOutSource, ConsentEvent, ConsentMeta, OptInSource, ReoptInRequest, OrgSettings, Delivery, DeliveryStatus, Invitation, InvitationPreview, Membership, MemberRole, Metrics, Opportunity,
  Suggestion, SuppressionReason, TeamMember
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
  listQueue(actor: Actor, limit: number): Promise<{ items: Opportunity[]; total: number }>;
  getOpportunity(actor: Actor, id: string): Promise<Opportunity | null>;
  /** Throws StoreError(not_found|conflict). */
  skip(actor: Actor, id: string): Promise<void>;
  saveSuggestion(actor: Actor, id: string, suggestion: Suggestion): Promise<void>;
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
  acceptInvitation(user: { id: string; email: string | null }, tokenHash: string): Promise<{ orgId: string; role: MemberRole; alreadyMember: boolean }>;

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

export const DEFAULT_SETTINGS: OrgSettings = { storeName: null, emailSignature: "", smsSignature: "", defaultChannel: null, maxDiscountPercent: 25, aiModel: DEFAULT_AI_MODEL };
