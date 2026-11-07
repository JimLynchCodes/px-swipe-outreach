import type { AppConfig } from "../config.js";
import type { RetryOpts } from "./http.js";
import type { JobId, LogLine, Progress, SyncRepo } from "./types.js";

export type JobContext = {
  orgId: string;
  params: Record<string, unknown>;
  dryRun: boolean;
  /** Writes are no-ops (counted only) in dry-run. Watermarks aren't advanced in dry-run. */
  repo: SyncRepo;
  config: AppConfig;
  fetchImpl: typeof fetch;
  retry: RetryOpts;
  now: Date;
  log: (level: LogLine["level"], msg: string, data?: Record<string, unknown>) => void;
  progress: (p: Progress) => void;
  read: (n: number) => void;
  wrote: (n: number) => void;
};

export type JobDef = {
  id: JobId;
  label: string;
  description: string;
  /** Env vars that are missing for this job (empty = configured). Values are never exposed, only names. */
  missingEnv: (c: AppConfig) => string[];
  supportsBackfill?: boolean;
  run: (ctx: JobContext) => Promise<void>;
};

export class ConfigError extends Error { constructor(m: string) { super(m); this.name = "ConfigError"; } }

export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000));
