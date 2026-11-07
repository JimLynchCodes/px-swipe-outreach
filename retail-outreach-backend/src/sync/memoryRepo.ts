import { randomUUID } from "node:crypto";
import type { EmailTrackingRow, EtlRun, JobId, LogLine, Order, Progress, ReconciledUsageRow, RewardsMember, RunTrigger, Schedule, SyncRepo, TwilioMessageRow, TwilioUsageRow, UpsertResult } from "./types.js";

export const DEFAULT_TIMEZONE = "America/New_York";

/** In-process sync repo (demo mode + tests). Same semantics as PgSyncRepo, including the per-job lock. */
export class MemorySyncRepo implements SyncRepo {
  tz = new Map<string, string>();
  schedules = new Map<string, Schedule>();
  runs: Array<EtlRun & { log: LogLine[] }> = [];
  watermarks = new Map<string, string>();
  providerUsage = new Map<string, ReconciledUsageRow>();
  twilioUsage = new Map<string, TwilioUsageRow>();
  smsCosts = new Map<string, TwilioMessageRow & { orgId: string }>();
  email = new Map<string, EmailTrackingRow>();
  customers = new Map<string, RewardsMember & { orgId: string; rewardsMember: boolean }>();
  orders = new Map<string, Order & { orgId: string }>();
  aiUsage: Array<{ orgId: string; provider: string; day: string; model: string; costUsd: number }> = [];
  emailDeliveries: Array<{ orgId: string; id: string; providerMessageId: string | null; status: string; error: string | null; createdAt: string; updatedAt: string }> = [];
  constructor(private clock: () => Date = () => new Date()) {}

  async getTimezone(orgId: string) { return this.tz.get(orgId) ?? DEFAULT_TIMEZONE; }
  async setTimezone(orgId: string, tz: string) { this.tz.set(orgId, tz); }
  async listSchedules(orgId: string) { return [...this.schedules.values()].filter(s => s.orgId === orgId); }
  async upsertSchedule(s: Schedule) { this.schedules.set(`${s.orgId}|${s.job}`, { ...s }); return { ...s }; }
  async claimDueSchedules(now: Date, next: (s: Schedule, tz: string) => Date | null, limit = 20) {
    const due = [...this.schedules.values()].filter(s => s.frequency !== "off" && s.nextRunAt && Date.parse(s.nextRunAt) <= now.getTime()).slice(0, limit);
    for (const s of due) s.nextRunAt = next(s, await this.getTimezone(s.orgId))?.toISOString() ?? null;
    return due.map(s => ({ ...s }));
  }

  async claimRun(r: { orgId: string; job: JobId; trigger: RunTrigger; dryRun: boolean; params: Record<string, unknown>; startedBy: string | null; staleMs: number }) {
    const now = this.clock();
    for (const x of this.runs) if (x.orgId === r.orgId && x.job === r.job && x.status === "running" && now.getTime() - Date.parse(x.heartbeatAt) > r.staleMs) {
      Object.assign(x, { status: "failed", error: "Run stopped responding (process restarted?)", finishedAt: now.toISOString() });
    }
    if (this.runs.some(x => x.orgId === r.orgId && x.job === r.job && x.status === "running")) return null;
    const run = { id: randomUUID(), orgId: r.orgId, job: r.job, trigger: r.trigger, status: "running" as const, dryRun: r.dryRun, params: r.params, progress: {},
      rowsRead: 0, rowsWritten: 0, error: null, startedAt: now.toISOString(), finishedAt: null, heartbeatAt: now.toISOString(), durationMs: null, log: [] as LogLine[] };
    this.runs.push(run);
    return strip(run);
  }
  async updateRun(id: string, p: { progress?: Progress; rowsRead?: number; rowsWritten?: number; appendLog?: LogLine[] }) {
    const r = this.runs.find(x => x.id === id && x.status === "running");
    if (!r) return;
    if (p.progress) r.progress = p.progress;
    if (p.rowsRead !== undefined) r.rowsRead = p.rowsRead;
    if (p.rowsWritten !== undefined) r.rowsWritten = p.rowsWritten;
    if (p.appendLog) r.log.push(...p.appendLog);
    r.heartbeatAt = this.clock().toISOString();
  }
  async finishRun(id: string, f: { status: "succeeded" | "failed"; error: string | null; rowsRead: number; rowsWritten: number; progress: Progress; appendLog: LogLine[] }) {
    const r = this.runs.find(x => x.id === id);
    if (!r) return;
    const end = new Date(Math.max(this.clock().getTime(), Date.parse(r.startedAt)));
    Object.assign(r, { status: f.status, error: f.error, rowsRead: f.rowsRead, rowsWritten: f.rowsWritten, progress: f.progress, finishedAt: end.toISOString(), durationMs: end.getTime() - Date.parse(r.startedAt) });
    r.log.push(...f.appendLog);
  }
  async listRuns(orgId: string, q: { job?: JobId; limit: number }) {
    return this.runs.filter(r => r.orgId === orgId && (!q.job || r.job === q.job)).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, q.limit).map(strip);
  }
  async getRun(orgId: string, id: string) { const r = this.runs.find(x => x.orgId === orgId && x.id === id); return r ? { ...r, log: [...r.log] } : null; }
  async latestRuns(orgId: string) {
    const by = new Map<string, EtlRun>();
    for (const r of [...this.runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) if (r.orgId === orgId) by.set(r.job, strip(r));
    return [...by.values()];
  }
  async getWatermark(orgId: string, job: string) { return this.watermarks.get(`${orgId}|${job}`) ?? null; }
  async setWatermark(orgId: string, job: string, cursor: string) { this.watermarks.set(`${orgId}|${job}`, cursor); }

  async recordedAiUsage(orgId: string, sinceDay: string) {
    const m = new Map<string, { provider: string; day: string; model: string; costUsd: number; calls: number }>();
    for (const u of this.aiUsage) if (u.orgId === orgId && u.day >= sinceDay) {
      const k = `${u.provider}|${u.day}|${u.model}`;
      const r = m.get(k) ?? { provider: u.provider, day: u.day, model: u.model, costUsd: 0, calls: 0 };
      r.costUsd += u.costUsd; r.calls++; m.set(k, r);
    }
    return [...m.values()];
  }
  private put<T>(map: Map<string, T>, key: string, v: T, res: UpsertResult) { if (map.has(key)) res.updated++; else res.inserted++; map.set(key, v); }
  async upsertProviderUsage(orgId: string, rows: ReconciledUsageRow[]) { const r = { inserted: 0, updated: 0 }; for (const x of rows) this.put(this.providerUsage, `${orgId}|${x.provider}|${x.day}|${x.model}`, x, r); return r; }
  async upsertTwilioUsage(orgId: string, rows: TwilioUsageRow[]) { const r = { inserted: 0, updated: 0 }; for (const x of rows) this.put(this.twilioUsage, `${orgId}|${x.day}|${x.category}`, x, r); return r; }
  async upsertSmsCosts(orgId: string, rows: TwilioMessageRow[]) {
    const r = { inserted: 0, updated: 0 };
    for (const x of rows) { const prev = this.smsCosts.get(x.sid); this.put(this.smsCosts, x.sid, { ...x, priceUsd: x.priceUsd ?? prev?.priceUsd ?? null, orgId: prev?.orgId ?? orgId }, r); }
    return r;
  }
  async listEmailDeliveries(orgId: string, sinceIso: string) { return this.emailDeliveries.filter(d => d.orgId === orgId && d.updatedAt >= sinceIso); }
  async upsertEmailTracking(orgId: string, rows: EmailTrackingRow[]) { const r = { inserted: 0, updated: 0 }; for (const x of rows) this.put(this.email, `${orgId}|${x.messageId}`, x, r); return r; }
  private match(orgId: string, c: { externalId: string | null; phone: string | null; email: string | null }) {
    for (const [k, v] of this.customers) if (v.orgId === orgId && ((c.externalId && v.externalId === c.externalId) || (c.phone && v.phone === c.phone) || (c.email && v.email === c.email))) return k;
    return null;
  }
  async upsertRewardsMembers(orgId: string, rows: RewardsMember[]) {
    const r = { inserted: 0, updated: 0, matched: 0 };
    for (const m of rows) {
      const k = this.match(orgId, m);
      if (k) { r.matched++; r.updated++; this.customers.set(k, { ...this.customers.get(k)!, ...m, rewardsMember: true }); }
      else { r.inserted++; this.customers.set(randomUUID(), { ...m, orgId, rewardsMember: true }); }
    }
    return r;
  }
  async upsertOrders(orgId: string, rows: Order[]) {
    const r = { inserted: 0, updated: 0, skipped: 0 };
    for (const o of rows) {
      if (!o.customer.phone && !o.customer.email && !(o.customer.externalId && this.match(orgId, o.customer))) { r.skipped++; continue; }
      this.put(this.orders, `${orgId}|${o.externalId}`, { ...o, orgId }, r);
    }
    return r;
  }
}
const strip = ({ log: _l, ...r }: EtlRun & { log?: LogLine[] }): EtlRun => ({ ...r });
