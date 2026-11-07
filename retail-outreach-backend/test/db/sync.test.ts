/** PgSyncRepo against real Postgres (TEST_DATABASE_URL; THE DATABASE IS WIPED). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { migrate } from "../../src/db/migrate.js";
import { seedOrg } from "../../src/db/seed.js";
import { PgSyncRepo } from "../../src/sync/pgRepo.js";
import { nextRunAfter } from "../../src/sync/schedule.js";

const url = process.env.TEST_DATABASE_URL;
const ORG = "cccccccc-0000-4000-8000-00000000000c";
const OWNER = "c0000000-0000-4000-8000-000000000001", STAFF = "c0000000-0000-4000-8000-000000000002";

describe.skipIf(!url)("PgSyncRepo", () => {
  let pool: pg.Pool, repo: PgSyncRepo;
  async function asUser(userId: string, sql: string, params: unknown[] = []) {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: "authenticated" })]);
      await c.query("set local role authenticated");
      return await c.query(sql, params);
    } finally { await c.query("rollback").catch(() => {}); c.release(); }
  }
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 6 });
    await pool.query(`drop schema if exists public cascade; create schema public; drop schema if exists auth cascade; drop schema if exists supabase_migrations cascade;`);
    await migrate(url!, { bootstrapPlainPostgres: true, log: () => {} });
    await pool.query(`insert into auth.users (id, email) values ($1,'o@c.test'),($2,'s@c.test')`, [OWNER, STAFF]);
    const c = await pool.connect();
    await seedOrg(c, { orgId: ORG, name: "Org C", slug: "org-c", businessName: "Shop C", ownerId: OWNER });
    await c.query(`insert into public.memberships (org_id, user_id, role) values ($1,$2,'staff')`, [ORG, STAFF]);
    c.release();
    repo = new PgSyncRepo(pool);
  }, 60_000);
  afterAll(async () => { await pool?.end(); });

  it("the run lock admits one running run per org+job, even under concurrent claims; stale runs are reaped", async () => {
    const claim = () => repo.claimRun({ orgId: ORG, job: "email", trigger: "manual", dryRun: false, params: {}, startedBy: null, staleMs: 600_000 });
    const results = await Promise.all([claim(), claim(), claim(), claim()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const run = results.find(Boolean)!;
    await repo.updateRun(run.id, { progress: { phase: "x", done: 1 }, rowsRead: 2, appendLog: [{ at: "t", level: "info", msg: "hello" }] });
    await repo.finishRun(run.id, { status: "succeeded", error: null, rowsRead: 3, rowsWritten: 2, progress: { phase: "Done" }, appendLog: [{ at: "t", level: "info", msg: "bye" }] });
    const got = (await repo.getRun(ORG, run.id))!;
    expect(got).toMatchObject({ status: "succeeded", rowsRead: 3, rowsWritten: 2 });
    expect(got.log!.map(l => l.msg)).toEqual(["hello", "bye"]);
    expect(got.durationMs).toBeGreaterThanOrEqual(0);

    const a = (await repo.claimRun({ orgId: ORG, job: "twilio", trigger: "manual", dryRun: false, params: {}, startedBy: null, staleMs: 600_000 }))!;
    await pool.query(`update public.etl_runs set heartbeat_at = now() - interval '1 hour' where id = $1`, [a.id]);
    const b = await repo.claimRun({ orgId: ORG, job: "twilio", trigger: "manual", dryRun: false, params: {}, startedBy: null, staleMs: 600_000 });
    expect(b).not.toBeNull();
    expect((await repo.getRun(ORG, a.id))!.status).toBe("failed");
    expect((await repo.latestRuns(ORG)).map(r => r.job).sort()).toEqual(["email", "twilio"]);
  });

  it("due schedules are claimed by exactly one of several concurrent schedulers and advanced past now", async () => {
    await repo.setTimezone(ORG, "America/New_York");
    await repo.upsertSchedule({ orgId: ORG, job: "ai-usage", frequency: "daily", startLocal: "2026-11-01T10:00:00", nextRunAt: "2026-11-02T15:00:00.000Z" }, OWNER);
    const now = new Date("2026-11-07T20:00:00Z");
    const next = (s: any, tz: string) => nextRunAfter(s.startLocal, s.frequency, tz, now.getTime());
    const claims = await Promise.all([1, 2, 3].map(() => repo.claimDueSchedules(now, next)));
    expect(claims.flat()).toHaveLength(1);
    expect(claims.flat()[0]).toMatchObject({ job: "ai-usage", startLocal: "2026-11-01T10:00:00" });
    expect((await repo.listSchedules(ORG))[0].nextRunAt).toBe("2026-11-08T15:00:00.000Z");
    expect(await repo.claimDueSchedules(now, next)).toEqual([]);
  });

  it("orders upsert idempotently, match customers by phone/email, and refresh profile columns; rewards update points", async () => {
    await pool.query(`insert into public.customers (org_id, first_name, phone, email) values ($1, 'Zedjamal', '+1 (555) 919-0001', null), ($1, 'Yarasarah', null, 'Yara@Example.com')`, [ORG]);
    const orders = [
      { externalId: "O1", at: "2026-11-02T15:15:00.000Z", customer: { externalId: null, name: "Jamal Carter", phone: "+15559190001", email: null }, subtotalCents: 2100, discountCents: 100, totalCents: 2000, paymentMethod: "Card",
        items: [{ name: "Cigar", sku: null, category: "Cigars", brand: "AF", quantity: 2, unitPriceCents: 950, discountCents: 0 }, { name: "Papers", sku: null, category: "Papers", brand: "ZZ", quantity: 1, unitPriceCents: 200, discountCents: 0 }] },
      { externalId: "O2", at: "2026-11-03T15:00:00.000Z", customer: { externalId: null, name: "Jamal", phone: "5559190001", email: null }, subtotalCents: 950, discountCents: 0, totalCents: 950, paymentMethod: "Cash",
        items: [{ name: "Cigar", sku: null, category: "Cigars", brand: "AF", quantity: 1, unitPriceCents: 950, discountCents: 0 }] },
      { externalId: "O3", at: "2026-11-04T15:00:00.000Z", customer: { externalId: null, name: "Walk-in", phone: null, email: null }, subtotalCents: 100, discountCents: 0, totalCents: 100, paymentMethod: "Cash", items: [] },
      { externalId: "O4", at: "2026-11-04T23:00:00.000Z", customer: { externalId: null, name: "New Person", phone: "+15559199999", email: null }, subtotalCents: 500, discountCents: 0, totalCents: 500, paymentMethod: "Card", items: [] }
    ];
    expect(await repo.upsertOrders(ORG, orders)).toEqual({ inserted: 3, updated: 0, skipped: 1 });
    expect(await repo.upsertOrders(ORG, orders)).toEqual({ inserted: 0, updated: 3, skipped: 1 });
    expect((await pool.query(`select count(*)::int n from public.purchase_items i join public.purchases p on p.id = i.purchase_id where i.org_id = $1 and p.external_id like 'qv:%'`, [ORG])).rows[0].n).toBe(3);
    const j = (await pool.query(`select * from public.customers where org_id = $1 and first_name = 'Zedjamal'`, [ORG])).rows[0];
    expect(j).toMatchObject({ lifetime_spend_cents: "2950", avg_basket_cents: 1475, favorite_categories: ["Cigars", "Papers"], favorite_brands: ["AF", "ZZ"], preferred_time: "morning" });
    expect([0, 1]).toContain(j.preferred_day); // Mon/Tue (mode of a tie)
    expect((await pool.query(`select source from public.customers where org_id = $1 and phone = '+15559199999'`, [ORG])).rows[0].source).toBe("quickvee");

    const r = await repo.upsertRewardsMembers(ORG, [{ externalId: "R101", firstName: "Sarah", lastName: "Kim", phone: null, email: "yara@example.com", points: 1200, joinedAt: "2024-11-02" },
      { externalId: "R200", firstName: null, lastName: null, phone: "+15559197777", email: null, points: 5, joinedAt: null }]);
    expect(r).toEqual({ inserted: 1, updated: 1, matched: 1 });
    const s = (await pool.query(`select rewards_member, rewards_points, external_id from public.customers where org_id = $1 and first_name = 'Yarasarah'`, [ORG])).rows[0];
    expect(s).toEqual({ rewards_member: true, rewards_points: 1200, external_id: "qv:R101" });
    expect((await repo.upsertRewardsMembers(ORG, [{ externalId: "R101", firstName: "Sarah", lastName: "Kim", phone: null, email: "yara@example.com", points: 1300, joinedAt: null }])).matched).toBe(1);
  });

  it("sms costs backfill by SID; usage/email upserts are idempotent; watermarks", async () => {
    await pool.query(`insert into public.sms_costs (org_id, provider, message_sid, segments, price_usd, estimated) values ($1, 'twilio', 'SMaaaaaaaaaa1', 1, 0.0125, true)`, [ORG]);
    const rows = [{ sid: "SMaaaaaaaaaa1", priceUsd: 0.0083, segments: 1, status: "delivered", sentAt: "2026-11-05T14:00:00Z" }, { sid: "SMbbbbbbbbbb2", priceUsd: null, segments: 2, status: "sent", sentAt: "2026-11-05T15:00:00Z" }];
    expect(await repo.upsertSmsCosts(ORG, rows)).toEqual({ inserted: 1, updated: 1 });
    const got = (await pool.query(`select message_sid, price_usd::float8 p, estimated, status from public.sms_costs where message_sid in ('SMaaaaaaaaaa1', 'SMbbbbbbbbbb2') order by message_sid`)).rows;
    expect(got).toEqual([{ message_sid: "SMaaaaaaaaaa1", p: 0.0083, estimated: false, status: "delivered" }, { message_sid: "SMbbbbbbbbbb2", p: 0, estimated: true, status: "sent" }]);
    const u = [{ provider: "openrouter" as const, day: "2026-11-05", model: "openai/gpt-4o-mini", requests: 1, inputTokens: 1, outputTokens: 1, costUsd: 0.01, recordedCostUsd: 0.009, recordedCalls: 1 }];
    expect(await repo.upsertProviderUsage(ORG, u)).toEqual({ inserted: 1, updated: 0 });
    expect(await repo.upsertProviderUsage(ORG, u)).toEqual({ inserted: 0, updated: 1 });
    expect(await repo.upsertEmailTracking(ORG, [{ messageId: "m1", deliveryId: null, provider: "ledger", status: "sent", bounceType: null, sentAt: null, lastEventAt: null }])).toEqual({ inserted: 1, updated: 0 });
    await repo.setWatermark(ORG, "email", "a"); await repo.setWatermark(ORG, "email", "b");
    expect(await repo.getWatermark(ORG, "email")).toBe("b");
  });

  it("RLS: owners read sync data and edit schedules; staff see nothing", async () => {
    expect((await asUser(OWNER, `select id from public.etl_runs`)).rowCount).toBeGreaterThan(0);
    expect((await asUser(STAFF, `select id from public.etl_runs`)).rowCount).toBe(0);
    expect((await asUser(STAFF, `select * from public.provider_usage_daily`)).rowCount).toBe(0);
    await expect(asUser(STAFF, `insert into public.sync_schedules (org_id, job, start_local) values ($1, 'email', now())`, [ORG])).rejects.toThrow(/row-level security/);
    await expect(asUser(OWNER, `insert into public.etl_runs (org_id, job, trigger) values ($1, 'email', 'manual')`, [ORG])).rejects.toThrow(/permission denied/);
    expect((await asUser(OWNER, `update public.sync_schedules set frequency = 'off' where org_id = $1 returning job`, [ORG])).rowCount).toBe(1);
  });
});
