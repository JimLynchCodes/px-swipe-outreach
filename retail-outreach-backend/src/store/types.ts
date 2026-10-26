import type { Channel, Delivery, DeliveryStatus, Metrics, Opportunity, Suggestion } from "../types.js";

export class StoreError extends Error {
  constructor(public code: "not_found" | "conflict", message: string) { super(message); }
}

export type NewDelivery = {
  channel: Channel;
  recipient: string;
  message: string;
  subject: string | null;
  idempotencyKey: string;
};

/**
 * Persistence boundary. `memory` and `postgres` implementations must behave the same;
 * the shared contract tests in store.test.ts run against the memory store.
 */
export interface OutreachStore {
  /** Actionable (pending/drafted) opportunities, oldest first. */
  listQueue(tenantId: string, limit: number): Promise<{ items: Opportunity[]; total: number }>;
  getOpportunity(tenantId: string, id: string): Promise<Opportunity | null>;
  /** Throws StoreError(not_found|conflict). */
  skip(tenantId: string, id: string, actorId: string): Promise<void>;
  saveSuggestion(tenantId: string, id: string, actorId: string, suggestion: Suggestion): Promise<void>;
  /**
   * Atomically moves the opportunity to `queued` and records a delivery.
   * Idempotent per (tenant, idempotencyKey): a repeat returns the existing delivery with duplicate=true.
   */
  createDelivery(tenantId: string, opportunityId: string, actorId: string, d: NewDelivery):
    Promise<{ delivery: Delivery; duplicate: boolean }>;
  getDelivery(id: string): Promise<Delivery | null>;
  listDeliveries(tenantId: string, opportunityId: string): Promise<Delivery[]>;
  updateDelivery(id: string, status: DeliveryStatus, patch?: { providerMessageId?: string; error?: string }): Promise<void>;
  metrics(tenantId: string): Promise<Metrics>;
  /** Demo helper: put every opportunity back to pending. */
  reset(tenantId: string): Promise<void>;
  close(): Promise<void>;
}
