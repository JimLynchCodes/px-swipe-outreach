import type { SyncRepo, UpsertResult } from "./types.js";

/** Reads pass through; every write reports what it would do (all counted as inserts) and changes nothing. */
export function dryRunRepo(repo: SyncRepo): SyncRepo {
  const count = async (rows: unknown[]): Promise<UpsertResult> => ({ inserted: rows.length, updated: 0, matched: 0, skipped: 0 });
  return new Proxy(repo, {
    get(target, prop, recv) {
      if (prop === "setWatermark") return async () => {};
      if (typeof prop === "string" && prop.startsWith("upsert") && prop !== "upsertSchedule") return (_org: string, rows: unknown[]) => count(rows);
      const v = Reflect.get(target, prop, recv);
      return typeof v === "function" ? v.bind(target) : v;
    }
  });
}
