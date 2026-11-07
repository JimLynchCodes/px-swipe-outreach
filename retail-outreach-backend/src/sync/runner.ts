/**
 * Runs sync jobs in the background: claims the per-(org, job) lock (a unique "running" row in etl_runs), streams
 * progress/log lines into the run row (throttled) so the UI can poll, heartbeats so a crashed process's run is
 * reclaimed, and records the outcome. Secrets from config are redacted from every log line and error.
 */
import type { AppConfig } from "../config.js";
import { StoreError } from "../store/types.js";
import type { JobContext, JobDef } from "./job.js";
import type { RetryOpts } from "./http.js";
import { JOBS } from "./registry.js";
import type { EtlRun, JobId, LogLine, Progress, RunTrigger, SyncRepo } from "./types.js";
import { dryRunRepo } from "./dryRun.js";

const SECRET_KEYS = ["OPENAI_API_KEY", "OPENAI_ADMIN_KEY", "OPENROUTER_API_KEY", "OPENROUTER_PROVISIONING_KEY", "TWILIO_AUTH_TOKEN", "SENDGRID_API_KEY", "QUICKVEE_PASSWORD", "QUICKVEE_EMAIL", "DATABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;
const MAX_LOG = 500;

export type StartRun = { orgId: string; job: JobId; trigger: RunTrigger; params?: Record<string, unknown>; dryRun?: boolean; startedBy?: string | null };
type Logger = { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void };

export class SyncRunner {
  private active = new Map<string, Promise<void>>();
  constructor(private repo: SyncRepo, private config: AppConfig, private opts: {
    jobs?: Partial<Record<JobId, JobDef>>; fetchImpl?: typeof fetch; retry?: RetryOpts; logger?: Logger; flushMs?: number; heartbeatMs?: number; staleMs?: number; now?: () => Date;
  } = {}) {}

  job(id: JobId): JobDef { return (this.opts.jobs?.[id] ?? JOBS[id]); }
  missingEnv(id: JobId) { return this.job(id).missingEnv(this.config); }

  private redact(s: string): string {
    let out = s;
    for (const k of SECRET_KEYS) {
      const v = (this.config as Record<string, unknown>)[k];
      if (typeof v === "string" && v.length >= 4) out = out.split(v).join("[redacted]");
    }
    return out.replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, "$1 [redacted]");
  }

  /** Claims the lock and starts the job in the background. Throws StoreError(conflict) if it's already running. */
  async start(s: StartRun): Promise<EtlRun> {
    const missing = this.missingEnv(s.job);
    if (missing.length) throw new StoreError("conflict", `${this.job(s.job).label} isn't configured: set ${missing.join(", ")}`, "not_configured");
    const run = await this.repo.claimRun({ orgId: s.orgId, job: s.job, trigger: s.trigger, dryRun: !!s.dryRun, params: s.params ?? {}, startedBy: s.startedBy ?? null, staleMs: this.opts.staleMs ?? 10 * 60_000 });
    if (!run) throw new StoreError("conflict", `${this.job(s.job).label} is already running`, "already_running");
    const p = this.execute(run).finally(() => this.active.delete(run.id));
    this.active.set(run.id, p);
    return run;
  }

  /** Resolves when the run finishes (tests, CLI). */
  async wait(runId: string) { await this.active.get(runId); }
  async drain() { await Promise.allSettled([...this.active.values()]); }
  get running() { return this.active.size; }

  private async execute(run: EtlRun) {
    const def = this.job(run.job);
    const pending: LogLine[] = [];
    let progress: Progress = {}, rowsRead = 0, rowsWritten = 0, logged = 0, dirty = false;
    const flush = async () => {
      if (!dirty && !pending.length) return;
      dirty = false;
      const lines = pending.splice(0);
      await this.repo.updateRun(run.id, { progress, rowsRead, rowsWritten, appendLog: lines }).catch(e => this.opts.logger?.warn({ err: e }, "sync: progress update failed"));
    };
    const timer = setInterval(() => void flush(), this.opts.flushMs ?? 1000);
    const heartbeat = setInterval(() => { dirty = true; }, this.opts.heartbeatMs ?? 15_000);
    timer.unref?.(); heartbeat.unref?.();
    const log: JobContext["log"] = (level, msg, data) => {
      const line: LogLine = { at: new Date().toISOString(), level, msg: this.redact(msg), ...(data ? { data: JSON.parse(this.redact(JSON.stringify(data))) } : {}) };
      this.opts.logger?.[level]({ job: run.job, runId: run.id, ...(line.data ?? {}) }, `sync: ${line.msg}`);
      if (logged++ < MAX_LOG) pending.push(line);
    };
    const ctx: JobContext = {
      orgId: run.orgId, params: run.params, dryRun: run.dryRun, repo: run.dryRun ? dryRunRepo(this.repo) : this.repo, config: this.config,
      fetchImpl: this.opts.fetchImpl ?? fetch, now: this.opts.now?.() ?? new Date(), log,
      retry: { ...this.opts.retry, onRetry: (attempt, delayMs, err) => log("warn", `Retry ${attempt} in ${delayMs}ms`, { error: String((err as Error)?.message ?? err) }) },
      progress: p => { progress = { ...progress, ...p }; dirty = true; },
      read: n => { rowsRead += n; dirty = true; },
      wrote: n => { rowsWritten += n; dirty = true; }
    };
    log("info", `Started ${def.label}${run.dryRun ? " (dry run: nothing is written)" : ""}`, Object.keys(run.params).length ? { params: run.params } : undefined);
    let status: "succeeded" | "failed" = "succeeded", error: string | null = null;
    try { await def.run(ctx); }
    catch (e) {
      status = "failed";
      error = this.redact(String((e as Error)?.message ?? e)).slice(0, 2000);
      log("error", error);
    } finally {
      clearInterval(timer); clearInterval(heartbeat);
    }
    if (status === "succeeded") log("info", `Finished: ${rowsRead} read, ${rowsWritten} written`);
    await this.repo.finishRun(run.id, { status, error, rowsRead, rowsWritten, progress, appendLog: pending.splice(0) })
      .catch(e => this.opts.logger?.error({ err: e, runId: run.id }, "sync: could not record run result"));
  }
}
