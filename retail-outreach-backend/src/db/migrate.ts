/**
 * Applies supabase/migrations/*.sql in order, recording each in supabase_migrations.schema_migrations
 * (the same table the Supabase CLI uses, so `supabase db push` and this script agree on what's applied).
 *
 *   npm run db:migrate                               # DATABASE_URL from env
 *   npm run db:migrate -- --bootstrap-plain-postgres # local/CI plain Postgres: create Supabase roles + auth stub first
 *
 * Prefer `supabase db push` for hosted projects; this exists for CI, Docker and environments without the CLI.
 */
import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPool } from "./pool.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoSupabase = process.env.SUPABASE_DIR ?? path.resolve(here, "../../../supabase");

export async function migrate(databaseUrl: string, opts: { bootstrapPlainPostgres?: boolean; log?: (s: string) => void } = {}) {
  const log = opts.log ?? console.log;
  const pool = createPool(databaseUrl, { max: 1, statementTimeoutMs: 120_000 });
  const db = await pool.connect();
  try {
    if (opts.bootstrapPlainPostgres) {
      const exists = await db.query(`select 1 from pg_namespace where nspname = 'auth'`);
      if (!exists.rowCount) {
        await db.query(await readFile(path.join(repoSupabase, "tests/bootstrap_plain_postgres.sql"), "utf8"));
        log("Bootstrapped Supabase roles + auth schema stub (plain Postgres).");
      }
    }
    await db.query(`create schema if not exists supabase_migrations;
      create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text)`);
    // Serialize concurrent migrators (e.g. several containers booting at once).
    await db.query(`select pg_advisory_lock(hashtext('px-outreach-migrations'))`);
    const applied = new Set((await db.query(`select version from supabase_migrations.schema_migrations`)).rows.map(r => r.version));
    const dir = path.join(repoSupabase, "migrations");
    const files = (await readdir(dir)).filter(f => /^\d{14}_.+\.sql$/.test(f)).sort();
    let count = 0;
    for (const file of files) {
      const [version, ...rest] = file.replace(/\.sql$/, "").split("_");
      if (applied.has(version)) continue;
      const sql = await readFile(path.join(dir, file), "utf8");
      await db.query("begin");
      try {
        await db.query(sql);
        await db.query(`insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)`,
          [version, rest.join("_"), [sql]]);
        await db.query("commit");
      } catch (e) {
        await db.query("rollback");
        throw new Error(`Migration ${file} failed: ${(e as Error).message}`);
      }
      log(`Applied ${file}`);
      count++;
    }
    log(count ? `${count} migration(s) applied.` : "Database is up to date.");
  } finally {
    await db.query(`select pg_advisory_unlock_all()`).catch(() => undefined);
    db.release();
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL is required"); process.exit(1); }
  migrate(url, { bootstrapPlainPostgres: process.argv.includes("--bootstrap-plain-postgres") })
    .catch(e => { console.error(e.message); process.exit(1); });
}
