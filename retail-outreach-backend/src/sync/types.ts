import type { Frequency } from "./schedule.js";

export const JOB_IDS = ["ai-usage", "twilio", "email", "quickvee-rewards", "quickvee-orders"] as const;
export type JobId = (typeof JOB_IDS)[number];
export type RunTrigger = "manual" | "schedule" | "backfill" | "cli";
export type RunStatus = "running" | "succeeded" | "failed";
export type LogLine = { at: string; level: "info" | "warn" | "error"; msg: string; data?: Record<string, unknown> };
export type Progress = { phase?: string; done?: number; total?: number };

export type EtlRun = {
  id: string; orgId: string; job: JobId; trigger: RunTrigger; status: RunStatus; dryRun: boolean;
  params: Record<string, unknown>; progress: Progress; rowsRead: number; rowsWritten: number; error: string | null;
  startedAt: string; finishedAt: string | null; heartbeatAt: string; durationMs: number | null; log?: LogLine[];
};
export type Schedule = { orgId: string; job: JobId; frequency: Frequency; startLocal: string; nextRunAt: string | null };

// ── Rows the jobs load ──
export type ProviderUsageRow = { provider: "openai" | "openrouter"; day: string; model: string; requests: number; inputTokens: number; outputTokens: number; costUsd: number };
export type ReconciledUsageRow = ProviderUsageRow & { recordedCostUsd: number; recordedCalls: number };
export type TwilioUsageRow = { day: string; category: string; count: number; usage: number; priceUsd: number };
export type TwilioMessageRow = { sid: string; priceUsd: number | null; segments: number; status: string; sentAt: string };
export type EmailTrackingRow = { messageId: string; deliveryId: string | null; provider: string; status: string; bounceType: string | null; sentAt: string | null; lastEventAt: string | null };
export type RewardsMember = { externalId: string; firstName: string | null; lastName: string | null; phone: string | null; email: string | null; points: number | null; joinedAt: string | null };
export type OrderItem = { name: string; sku: string | null; category: string | null; brand: string | null; quantity: number; unitPriceCents: number; discountCents: number };
export type Order = {
  externalId: string; at: string; customer: { externalId: string | null; name: string | null; phone: string | null; email: string | null };
  items: OrderItem[]; subtotalCents: number; discountCents: number; totalCents: number; paymentMethod: string | null;
};
export type UpsertResult = { inserted: number; updated: number; matched?: number; skipped?: number };

/**
 * Persistence for sync: schedules, the run log (+ lock), watermarks, and the data sinks. `PgSyncRepo` writes with the
 * backend's privileged connection (jobs are system operations); route handlers check owner/admin before calling.
 */
export interface SyncRepo {
  getTimezone(orgId: string): Promise<string>;
  setTimezone(orgId: string, tz: string): Promise<void>;
  listSchedules(orgId: string): Promise<Schedule[]>;
  upsertSchedule(s: Schedule, userId: string | null): Promise<Schedule>;
  /**
   * Atomically claims due schedules (Postgres: FOR UPDATE SKIP LOCKED, so only one instance gets each) and advances
   * next_run_at with `next` (first occurrence after now, i.e. missed runs collapse into one).
   */
  claimDueSchedules(now: Date, next: (s: Schedule, tz: string) => Date | null, limit?: number): Promise<Schedule[]>;

  /** The lock. Fails stale runs (heartbeat older than staleMs) first; returns null when the job is already running. */
  claimRun(r: { orgId: string; job: JobId; trigger: RunTrigger; dryRun: boolean; params: Record<string, unknown>; startedBy: string | null; staleMs: number }): Promise<EtlRun | null>;
  updateRun(id: string, patch: { progress?: Progress; rowsRead?: number; rowsWritten?: number; appendLog?: LogLine[] }): Promise<void>;
  finishRun(id: string, r: { status: "succeeded" | "failed"; error: string | null; rowsRead: number; rowsWritten: number; progress: Progress; appendLog: LogLine[] }): Promise<void>;
  listRuns(orgId: string, q: { job?: JobId; limit: number }): Promise<EtlRun[]>;
  getRun(orgId: string, id: string): Promise<EtlRun | null>;
  latestRuns(orgId: string): Promise<EtlRun[]>;

  getWatermark(orgId: string, job: string): Promise<string | null>;
  setWatermark(orgId: string, job: string, cursor: string): Promise<void>;

  /** App-recorded AI spend (ai_usage) per day/model/provider since a day (for reconciliation). */
  recordedAiUsage(orgId: string, sinceDay: string): Promise<Array<{ provider: string; day: string; model: string; costUsd: number; calls: number }>>;
  upsertProviderUsage(orgId: string, rows: ReconciledUsageRow[]): Promise<UpsertResult>;
  upsertTwilioUsage(orgId: string, rows: TwilioUsageRow[]): Promise<UpsertResult>;
  /** Backfills Twilio's actual price/segments/status into sms_costs by SID; unknown SIDs are inserted for this org. */
  upsertSmsCosts(orgId: string, rows: TwilioMessageRow[]): Promise<UpsertResult>;
  /** Email deliveries from the send ledger since a time (for tracking). */
  listEmailDeliveries(orgId: string, sinceIso: string): Promise<Array<{ id: string; providerMessageId: string | null; status: string; error: string | null; createdAt: string; updatedAt: string }>>;
  upsertEmailTracking(orgId: string, rows: EmailTrackingRow[]): Promise<UpsertResult>;
  /** Matches by phone/email, else by external id `qv:<id>`; creates customers as needed. */
  upsertRewardsMembers(orgId: string, rows: RewardsMember[]): Promise<UpsertResult>;
  /** Upserts purchases + items by external id `qv:<id>` (customer matched by phone/email/external id) and refreshes the derived profile columns. */
  upsertOrders(orgId: string, rows: Order[]): Promise<UpsertResult>;
}
