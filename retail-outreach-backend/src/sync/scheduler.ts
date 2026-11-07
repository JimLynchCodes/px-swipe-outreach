/**
 * DB-backed scheduler loop. Each tick claims due schedules (Postgres: FOR UPDATE SKIP LOCKED, so with several API/worker
 * instances exactly one gets each due job) and advances next_run_at to the first occurrence after now. A restart after
 * downtime therefore runs each missed job once, not once per missed slot. Runs go through SyncRunner, whose lock also
 * stops a schedule from overlapping a manual run.
 */
import { nextRunAfter } from "./schedule.js";
import type { SyncRunner } from "./runner.js";
import type { SyncRepo } from "./types.js";
import { StoreError } from "../store/types.js";

type Logger = { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void };

export class SyncScheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  constructor(private repo: SyncRepo, private runner: SyncRunner, private opts: { intervalMs?: number; logger?: Logger; now?: () => Date } = {}) {}

  async tick(): Promise<string[]> {
    if (this.ticking) return [];
    this.ticking = true;
    const started: string[] = [];
    try {
      const now = this.opts.now?.() ?? new Date();
      const due = await this.repo.claimDueSchedules(now, (s, tz) => nextRunAfter(s.startLocal, s.frequency, tz, now.getTime()));
      for (const s of due) {
        const missing = this.runner.missingEnv(s.job);
        if (missing.length) { this.opts.logger?.warn({ org: s.orgId, job: s.job, missing }, "sync: scheduled job skipped (not configured)"); continue; }
        try {
          const run = await this.runner.start({ orgId: s.orgId, job: s.job, trigger: "schedule" });
          started.push(run.id);
          this.opts.logger?.info({ org: s.orgId, job: s.job, runId: run.id }, "sync: scheduled run started");
        } catch (e) {
          if (e instanceof StoreError) this.opts.logger?.warn({ org: s.orgId, job: s.job }, `sync: scheduled run skipped: ${e.message}`);
          else throw e;
        }
      }
    } finally { this.ticking = false; }
    return started;
  }

  start() {
    if (this.timer) return;
    const run = () => this.tick().catch(e => this.opts.logger?.warn({ err: e }, "sync: scheduler tick failed"));
    this.timer = setInterval(run, this.opts.intervalMs ?? 60_000);
    this.timer.unref();
    void run();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
