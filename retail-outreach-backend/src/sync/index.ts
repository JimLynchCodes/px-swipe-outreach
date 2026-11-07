import type { AppConfig } from "../config.js";
import type { OutreachStore } from "../store/types.js";
import { MemorySyncRepo } from "./memoryRepo.js";
import { SyncRunner } from "./runner.js";
import { SyncScheduler } from "./scheduler.js";
import type { SyncRepo } from "./types.js";

export type SyncService = { repo: SyncRepo; runner: SyncRunner; scheduler: SyncScheduler };
type Logger = ConstructorParameters<typeof SyncRunner>[2] extends infer O ? O extends { logger?: infer L } ? L : never : never;

/** Postgres store → PgSyncRepo on its privileged pool; memory store → in-process repo (demo). */
export async function createSync(config: AppConfig, store: OutreachStore, logger?: Logger): Promise<SyncService> {
  let repo: SyncRepo;
  if (store.kind === "postgres") {
    const { PgSyncRepo } = await import("./pgRepo.js");
    repo = new PgSyncRepo((store as unknown as { pool: import("pg").Pool }).pool);
  } else repo = new MemorySyncRepo();
  const runner = new SyncRunner(repo, config, { logger });
  const scheduler = new SyncScheduler(repo, runner, { intervalMs: config.SYNC_SCHEDULER_INTERVAL_SECONDS * 1000, logger });
  return { repo, runner, scheduler };
}
export { JOB_IDS } from "./types.js";
