/**
 * Integration tests against a real Postgres with the Supabase migrations applied.
 * Skipped unless TEST_DATABASE_URL is set. THE DATABASE IS WIPED: point it at a throwaway instance.
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { migrate } from "../../src/db/migrate.js";
import { seedOrg, seedUuid } from "../../src/db/seed.js";
import { PostgresStore } from "../../src/store/postgres.js";
import { processDelivery } from "../../src/delivery.js";
import { ConsoleMessageProvider } from "../../src/providers/messaging.js";
import { StoreError } from "../../src/store/types.js";

const url = process.env.TEST_DATABASE_URL;
const ORG_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const ORG_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const ALICE = "a11ce000-0000-4000-8000-000000000001"; // owner of A
const BOB = "b0b00000-0000-4000-8000-000000000002";   // owner of B
const STAFF = "57aff000-0000-4000-8000-000000000003"; // staff in A
const opp = (org: string, cust: string) => seedUuid(org, `opp:${cust}`);

describe.skipIf(!url)("Postgres store + Supabase RLS", () => {
  let admin: pg.Pool;
  let store: PostgresStore;

  /** Run raw SQL as a given user through RLS, like PostgREST would. */
  async function asUser(userId: string, sql: string, params: unknown[] = []): Promise<pg.QueryResult<any>> {
    const c = await admin.connect();
    try {
      await c.query("begin");
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: "authenticated" })]);
      await c.query("set local role authenticated");
      return await c.query(sql, params);
    } finally {
      await c.query("rollback").catch(() => undefined);
      c.release();
    }
  }

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url, max: 4 });
    await admin.query(`drop schema if exists public cascade; create schema public;
      drop schema if exists auth cascade; drop schema if exists supabase_migrations cascade;`);
    await migrate(url!, { bootstrapPlainPostgres: true, log: () => {} });
    await admin.query(`insert into auth.users (id, email) values ($1,'alice@a.test'),($2,'bob@b.test'),($3,'staff@a.test')`, [ALICE, BOB, STAFF]);
    const c = await admin.connect();
    await seedOrg(c, { orgId: ORG_A, name: "Org A", slug: "org-a", businessName: "Shop A", ownerId: ALICE });
    await seedOrg(c, { orgId: ORG_B, name: "Org B", slug: "org-b", businessName: "Shop B", ownerId: BOB });
    await c.query(`insert into public.memberships (org_id, user_id, role) values ($1,$2,'staff')`, [ORG_A, STAFF]);
    c.release();
    store = new PostgresStore(url!);
  }, 60_000);

  afterAll(async () => { await store?.close(); await admin?.end(); });

  it("migrations are recorded and re-running is a no-op", async () => {
    const r = await admin.query(`select version from supabase_migrations.schema_migrations`);
    expect(r.rowCount).toBeGreaterThan(0);
    const logs: string[] = [];
    await migrate(url!, { bootstrapPlainPostgres: true, log: s => logs.push(s) });
    expect(logs).toContain("Database is up to date.");
  });

  it("every public table has RLS enabled", async () => {
    const r = await admin.query(`select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
    expect(r.rows).toEqual([]);
  });

  it("anon sees nothing", async () => {
    const c = await admin.connect();
    try {
      await c.query("begin; set local role anon");
      await expect(c.query("select * from public.customers")).rejects.toThrow(/permission denied/);
    } finally { await c.query("rollback"); c.release(); }
  });

  it("users only see their own org's rows (raw SQL through RLS)", async () => {
    const a = await asUser(ALICE, "select distinct org_id from public.customers");
    expect(a.rows.map(r => r.org_id)).toEqual([ORG_A]);
    const b = await asUser(BOB, "select count(*)::int as n from public.outreach_opportunities where org_id = $1", [ORG_A]);
    expect(b.rows[0].n).toBe(0);
    const nobody = await asUser("99999999-0000-4000-8000-000000000009", "select count(*)::int as n from public.organizations");
    expect(nobody.rows[0].n).toBe(0);
  });

  it("users cannot write into another org", async () => {
    await expect(asUser(BOB, `insert into public.suppressions (org_id, channel, value, created_by) values ($1,'sms','+15550000000',$2)`, [ORG_A, BOB]))
      .rejects.toThrow(/row-level security/);
    const upd = await asUser(BOB, `update public.outreach_opportunities set status = 'skipped' where org_id = $1`, [ORG_A]);
    expect(upd.rowCount).toBe(0);
    // cannot forge another user as the actor
    await expect(asUser(STAFF, `insert into public.outreach_events (org_id, actor_id, event_type) values ($1,$2,'x')`, [ORG_A, ALICE]))
      .rejects.toThrow(/row-level security/);
  });

  it("staff cannot change reference data or memberships; audit log is append-only", async () => {
    const r = await asUser(STAFF, `update public.customers set first_name = 'X' where org_id = $1`, [ORG_A]);
    expect(r.rowCount).toBe(0);
    await expect(asUser(STAFF, `insert into public.memberships (org_id, user_id, role) values ($1,$2,'owner')`, [ORG_A, BOB]))
      .rejects.toThrow(/row-level security/);
    await expect(asUser(ALICE, `delete from public.outreach_events`)).rejects.toThrow(/permission denied/);
    await expect(asUser(ALICE, `update public.message_deliveries set status = 'sent'`)).resolves.toMatchObject({ rowCount: 0 });
  });

  it("create_organization makes the caller owner", async () => {
    const r = await asUser(BOB, `select public.create_organization('Bob Two', 'bob-two') as id`);
    expect(r.rows[0].id).toMatch(/[0-9a-f-]{36}/);
  });

  it("PostgresStore: queue, memberships and cross-org isolation", async () => {
    const ms = await store.listMemberships(ALICE);
    expect(ms).toEqual([{ orgId: ORG_A, orgName: "Org A", businessName: "Shop A", role: "owner" }]);
    const q = await store.listQueue({ userId: ALICE, orgId: ORG_A }, 5);
    expect(q.total).toBe(20);
    expect(q.items[0].customer).toMatchObject({ firstName: "Sarah", storesShopped: expect.arrayContaining(["Downtown"]), suppressed: [] });
    expect(q.items[0].customer.purchases.length).toBe(3);
    // Bob passing Org A's id still gets nothing: RLS, not just the WHERE clause, protects it.
    const leak = await store.listQueue({ userId: BOB, orgId: ORG_A }, 5);
    expect(leak.total).toBe(0);
    expect(await store.getOpportunity({ userId: BOB, orgId: ORG_A }, opp(ORG_A, "cust_0001"))).toBeNull();
    expect(await store.getOpportunity({ userId: ALICE, orgId: ORG_A }, "not-a-uuid")).toBeNull();
    await expect(store.skip({ userId: BOB, orgId: ORG_A }, opp(ORG_A, "cust_0001"))).rejects.toMatchObject({ code: "not_found" });
  });

  it("PostgresStore: idempotent sends, one live delivery per opportunity, worker updates", async () => {
    const actor = { userId: STAFF, orgId: ORG_A };
    const id = opp(ORG_A, "cust_0002");
    const d = { channel: "sms" as const, recipient: "+15555550002", message: "Hi", subject: null, idempotencyKey: "idem-key-0001" };
    const [first, second] = await Promise.all([store.createDelivery(actor, id, d), store.createDelivery(actor, id, d)]);
    expect([first.duplicate, second.duplicate].sort()).toEqual([false, true]);
    expect(first.delivery.id).toBe(second.delivery.id);
    await expect(store.createDelivery(actor, id, { ...d, idempotencyKey: "idem-key-0002" })).rejects.toBeInstanceOf(StoreError);
    const messenger = new ConsoleMessageProvider(() => {});
    const done = await processDelivery(store, messenger, first.delivery.id);
    expect(done.status).toBe("sent");
    expect((await store.getOpportunity(actor, id))!.status).toBe("sent");
    const events = await admin.query(`select event_type, actor_id from public.outreach_events where opportunity_id = $1 order by id`, [id]);
    expect(events.rows).toEqual([
      { event_type: "send_queued", actor_id: STAFF },
      { event_type: "delivery_sent", actor_id: null }
    ]);
  });

  it("opt-out: suppression is enforced by the store and by the database trigger", async () => {
    const actor = { userId: STAFF, orgId: ORG_A };
    const id = opp(ORG_A, "cust_0003");
    await store.optOut(actor, id, ["sms"], "opt_out");
    const o = await store.getOpportunity(actor, id);
    expect(o).toMatchObject({ status: "suppressed", customer: { suppressed: ["sms"] } });
    expect(await store.isSuppressed(ORG_A, "sms", "+1 (555) 555-0003")).toBe(true);
    expect(await store.isSuppressed(ORG_B, "sms", "+15555550003")).toBe(false);
    // Even a direct insert (bypassing the app checks) is refused by the trigger.
    await expect(admin.query(`insert into public.message_deliveries (org_id, opportunity_id, channel, recipient, message, idempotency_key)
      values ($1, $2, 'sms', '+15555550003', 'hi', 'direct-insert-1')`, [ORG_A, id])).rejects.toThrow(/recipient_suppressed/);
    // Only admins can remove a suppression.
    const staffDel = await asUser(STAFF, `delete from public.suppressions where org_id = $1`, [ORG_A]);
    expect(staffDel.rowCount).toBe(0);
  });

  it("demo reset requires owner/admin", async () => {
    await expect(store.reset({ userId: STAFF, orgId: ORG_A })).rejects.toMatchObject({ code: "forbidden" });
    await store.reset({ userId: ALICE, orgId: ORG_A });
    expect((await store.listQueue({ userId: ALICE, orgId: ORG_A }, 1)).total).toBe(20);
  });
});
