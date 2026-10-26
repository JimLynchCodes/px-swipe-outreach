import pg from "pg";
import { config } from "../config.js";

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string, params: unknown[] = []
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(sql, params);
}
