import pg from "pg";

export type PoolOptions = { max?: number; caCert?: string; statementTimeoutMs?: number };

/**
 * Connection pool for the backend's privileged database role (Supabase `postgres` user via the
 * pooler, or a local Postgres). User requests drop to `role authenticated` per transaction, so RLS
 * applies to them; see PostgresStore.asUser.
 */
export function createPool(connectionString: string, opts: PoolOptions = {}) {
  return new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: opts.statementTimeoutMs ?? 15_000,
    application_name: "px-outreach-backend",
    ...(opts.caCert ? { ssl: { ca: opts.caCert, rejectUnauthorized: true } } : {})
  });
}
