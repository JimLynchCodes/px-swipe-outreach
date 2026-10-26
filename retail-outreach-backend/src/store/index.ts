import type { AppConfig } from "../config.js";
import type { OutreachStore } from "./types.js";

export async function createStore(config: AppConfig): Promise<OutreachStore> {
  if (config.DATA_STORE === "postgres") {
    const { PostgresStore } = await import("./postgres.js");
    return new PostgresStore(config.DATABASE_URL);
  }
  const { MemoryStore } = await import("./memory.js");
  return new MemoryStore();
}
export * from "./types.js";
