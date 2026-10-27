import type {
  Actor, Channel, Delivery, DeliveryStatus, Invitation, InvitationPreview, Membership, MemberRole, Metrics, Opportunity,
  Suggestion, SuppressionReason, TeamMember
} from "../types.js";

export type StoreErrorCode = "not_found" | "conflict" | "suppressed" | "forbidden" | "gone";

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
  optOut(actor: Actor, opportunityId: string, channels: Channel[], reason: SuppressionReason): Promise<void>;
  metrics(actor: Actor): Promise<Metrics>;
  /** Demo helper: put every opportunity back to pending and clear suppressions. */
  reset(actor: Actor): Promise<void>;

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
  /** Public accept-page details for a token holder; null when unknown. */
  previewInvitation(tokenHash: string): Promise<InvitationPreview | null>;
  /** True when the org's suppression list blocks this recipient (re-checked right before sending). */
  isSuppressed(orgId: string, channel: Channel, recipient: string): Promise<boolean>;
  getDelivery(id: string): Promise<Delivery | null>;
  updateDelivery(id: string, status: DeliveryStatus, patch?: { providerMessageId?: string; error?: string }): Promise<void>;
  close(): Promise<void>;
}
