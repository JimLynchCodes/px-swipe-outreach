import type {
  Actor, Channel, Delivery, DeliveryStatus, Membership, Metrics, Opportunity, Suggestion, SuppressionReason
} from "../types.js";

export type StoreErrorCode = "not_found" | "conflict" | "suppressed" | "forbidden";

export class StoreError extends Error {
  constructor(public code: StoreErrorCode, message: string) { super(message); this.name = "StoreError"; }
}

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

  // System operations (no user context).
  /** True when the org's suppression list blocks this recipient (re-checked right before sending). */
  isSuppressed(orgId: string, channel: Channel, recipient: string): Promise<boolean>;
  getDelivery(id: string): Promise<Delivery | null>;
  updateDelivery(id: string, status: DeliveryStatus, patch?: { providerMessageId?: string; error?: string }): Promise<void>;
  close(): Promise<void>;
}
