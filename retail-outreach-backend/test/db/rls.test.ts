/**
 * Integration tests against a real Postgres with the Supabase migrations applied.
 * Skipped unless TEST_DATABASE_URL is set. THE DATABASE IS WIPED: point it at a throwaway instance.
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm run test:db
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { parseOrderCsv } from "../../src/orders/csvImport.js";
import { migrate } from "../../src/db/migrate.js";
import { seedOrg, seedUuid } from "../../src/db/seed.js";
import { PostgresStore } from "../../src/store/postgres.js";
import { bootstrapOwner } from "../../src/db/bootstrapOwner.js";
import { processDelivery } from "../../src/delivery.js";
import { ConsoleMessageProvider } from "../../src/providers/messaging.js";
import { StoreError } from "../../src/store/types.js";
import { hashInviteToken, newInviteToken } from "../../src/team/tokens.js";

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
    expect(q.items[0].customer).toMatchObject({ firstName: "Sarah", storesShopped: expect.arrayContaining(["Main St"]), suppressed: [], ageVerified: true,
      profile: { favoriteCategories: ["cbd"], visitsPerMonth: 1, avgBasketCents: 9800, preferredDay: 0, preferredTime: "evening" } });
    expect(q.items[0].customer.purchases[0]).toMatchObject({ brand: "Charlotte's Web", category: "cbd" });
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
    // Nobody signed in (staff, admin or owner) can remove a suppression; only the customer's own action does.
    await expect(asUser(STAFF, `delete from public.suppressions where org_id = $1`, [ORG_A])).rejects.toThrow(/permission denied/);
  });

  it("demo reset requires owner/admin", async () => {
    await expect(store.reset({ userId: STAFF, orgId: ORG_A })).rejects.toMatchObject({ code: "forbidden" });
    await store.reset({ userId: ALICE, orgId: ORG_A });
    expect((await store.listQueue({ userId: ALICE, orgId: ORG_A }, 1)).total).toBe(20);
  });

  // ───────────────────────── Team management ─────────────────────────
  describe("team invitations & memberships", () => {
    const ADMIN = "ad000000-0000-4000-8000-000000000004";
    const NEWU = "0e000000-0000-4000-8000-000000000005";
    const A = { userId: ALICE, orgId: ORG_A };
    const inTwoDays = () => new Date(Date.now() + 2 * 86_400_000);
    const reason = (p: Promise<unknown>) => p.then(() => "ok", (e: any) => e instanceof StoreError ? e.reason ?? e.code : String(e?.message));

    beforeAll(async () => {
      await admin.query(`insert into auth.users (id, email) values ($1,'admin@a.test'),($2,'new@a.test') on conflict do nothing`, [ADMIN, NEWU]);
      await admin.query(`insert into public.memberships (org_id, user_id, role) values ($1,$2,'admin') on conflict do nothing`, [ORG_A, ADMIN]);
    });

    it("roster includes emails for members only", async () => {
      const ms = await store.listMembers(A);
      expect(ms.map(m => [m.email, m.role])).toEqual(expect.arrayContaining([["alice@a.test", "owner"], ["admin@a.test", "admin"], ["staff@a.test", "staff"]]));
      expect((await asUser(BOB, `select * from public.list_org_members($1)`, [ORG_A])).rowCount).toBe(0);
      await expect(reason(store.listMembers({ userId: BOB, orgId: ORG_A }))).resolves.toBe("forbidden");
    });

    it("RLS: only owners/admins see or create invites; admins can't invite owners; no deletes", async () => {
      const h = hashInviteToken(newInviteToken());
      const ins = (user: string, role: string) => asUser(user,
        `insert into public.invitations (org_id, email, role, token_hash, invited_by, expires_at) values ($1,'x@x.test',$2,$3,$4, now() + interval '1 day')`,
        [ORG_A, role, h, user]);
      await expect(ins(STAFF, "staff")).rejects.toThrow(/row-level security/);
      await expect(ins(ADMIN, "owner")).rejects.toThrow(/row-level security/);
      await expect(ins(BOB, "staff")).rejects.toThrow(/row-level security/);
      await expect(ins(ADMIN, "admin")).resolves.toBeTruthy();
      // invited_by must be the caller
      await expect(asUser(ADMIN, `insert into public.invitations (org_id, email, role, token_hash, invited_by, expires_at)
        values ($1,'y@x.test','staff',$2,$3, now() + interval '1 day')`, [ORG_A, h, ALICE])).rejects.toThrow(/row-level security/);
      const inv = await store.createInvitation(A, { email: "seen@a.test", role: "staff", tokenHash: hashInviteToken(newInviteToken()), expiresAt: inTwoDays() });
      expect((await asUser(STAFF, `select * from public.invitations`)).rowCount).toBe(0);
      expect((await asUser(BOB, `select * from public.invitations`)).rowCount).toBe(0);
      expect((await asUser(ADMIN, `select * from public.invitations where id = $1`, [inv.id])).rowCount).toBe(1);
      await expect(asUser(ALICE, `delete from public.invitations where id = $1`, [inv.id])).rejects.toThrow(/permission denied/);
      await expect(asUser(ALICE, `select token_hash from public.invitations limit 1`)).resolves.toBeTruthy();
    });

    it("store: invite → duplicate/member conflicts → resend rotates → accept with matching email", async () => {
      const raw = newInviteToken();
      const inv = await store.createInvitation({ userId: ADMIN, orgId: ORG_A }, { email: "New@A.test", role: "admin", tokenHash: hashInviteToken(raw), expiresAt: inTwoDays() });
      expect(inv).toMatchObject({ email: "new@a.test", role: "admin", status: "pending" });
      await expect(reason(store.createInvitation(A, { email: "new@a.test", role: "staff", tokenHash: hashInviteToken(newInviteToken()), expiresAt: inTwoDays() }))).resolves.toBe("already_invited");
      await expect(reason(store.createInvitation(A, { email: "staff@a.test", role: "staff", tokenHash: hashInviteToken(newInviteToken()), expiresAt: inTwoDays() }))).resolves.toBe("already_member");
      await expect(reason(store.refreshInvitation(A, inv.id, { tokenHash: hashInviteToken(newInviteToken()), expiresAt: inTwoDays(), cooldownSeconds: 60 }))).resolves.toBe("resend_cooldown");
      const raw2 = newInviteToken();
      expect((await store.refreshInvitation(A, inv.id, { tokenHash: hashInviteToken(raw2), expiresAt: inTwoDays(), cooldownSeconds: 0 })).sendCount).toBe(2);
      expect(await store.previewInvitation(hashInviteToken(raw))).toBeNull();
      expect(await store.previewInvitation(hashInviteToken(raw2))).toMatchObject({ orgName: "Org A", status: "pending", role: "admin" });

      await expect(reason(store.acceptInvitation({ id: NEWU, email: "other@a.test" }, hashInviteToken(raw2)))).resolves.toBe("invitation_email_mismatch");
      await expect(reason(store.acceptInvitation({ id: NEWU, email: null }, hashInviteToken(raw2)))).resolves.toBe("invitation_email_mismatch");
      await expect(reason(store.acceptInvitation({ id: NEWU, email: "new@a.test" }, hashInviteToken(raw)))).resolves.toBe("invitation_invalid");
      expect(await store.acceptInvitation({ id: NEWU, email: "NEW@a.test" }, hashInviteToken(raw2))).toEqual({ orgId: ORG_A, role: "admin", alreadyMember: false });
      expect((await store.acceptInvitation({ id: NEWU, email: "new@a.test" }, hashInviteToken(raw2))).alreadyMember).toBe(true);
      await expect(reason(store.acceptInvitation({ id: BOB, email: "new@a.test" }, hashInviteToken(raw2)))).resolves.toBe("invitation_used");
      expect((await store.listMemberships(NEWU)).map(m => m.orgId)).toEqual([ORG_A]);
      const ev = await admin.query(`select event_type, actor_id from public.outreach_events where org_id = $1 and opportunity_id is null order by created_at`, [ORG_A]);
      expect(ev.rows.map(r => r.event_type)).toEqual(expect.arrayContaining(["invitation_created", "invitation_resent", "invitation_accepted"]));
    });

    it("expired and revoked invites can't be accepted; an expired one is replaced on re-invite", async () => {
      const raw = newInviteToken();
      const inv = await store.createInvitation(A, { email: "late@a.test", role: "staff", tokenHash: hashInviteToken(raw), expiresAt: inTwoDays() });
      await admin.query(`update public.invitations set created_at = now() - interval '3 days', expires_at = now() - interval '1 second' where id = $1`, [inv.id]);
      await expect(reason(store.acceptInvitation({ id: NEWU, email: "late@a.test" }, hashInviteToken(raw)))).resolves.toBe("invitation_expired");
      const again = await store.createInvitation(A, { email: "late@a.test", role: "staff", tokenHash: hashInviteToken(newInviteToken()), expiresAt: inTwoDays() });
      expect(again.id).not.toBe(inv.id);
      await store.revokeInvitation(A, again.id);
      expect((await store.listInvitations(A)).some(i => i.email === "late@a.test")).toBe(false);
      await expect(reason(store.revokeInvitation(A, again.id))).resolves.toBe("not_found");
      await expect(reason(store.listInvitations({ userId: STAFF, orgId: ORG_A }))).resolves.toBe("insufficient_role");
    });

    it("role changes follow owner/admin rules and the last owner is protected everywhere", async () => {
      await expect(reason(store.changeMemberRole({ userId: ADMIN, orgId: ORG_A }, STAFF, "owner"))).resolves.toBe("insufficient_role");
      await expect(reason(store.changeMemberRole({ userId: ADMIN, orgId: ORG_A }, ALICE, "staff"))).resolves.toBe("insufficient_role");
      await expect(reason(store.removeMember({ userId: STAFF, orgId: ORG_A }, ADMIN))).resolves.toBe("insufficient_role");
      await expect(reason(store.changeMemberRole(A, ALICE, "admin"))).resolves.toBe("last_owner");
      await expect(reason(store.removeMember(A, ALICE))).resolves.toBe("last_owner");
      // Even a privileged connection can't strand the org.
      await expect(admin.query(`delete from public.memberships where org_id = $1 and user_id = $2`, [ORG_A, ALICE])).rejects.toThrow(/last_owner/);
      // RLS: staff can't promote themselves via raw SQL.
      expect((await asUser(STAFF, `update public.memberships set role = 'admin' where org_id = $1 and user_id = $2`, [ORG_A, STAFF])).rowCount).toBe(0);

      await store.changeMemberRole(A, NEWU, "owner");
      await store.changeMemberRole(A, ALICE, "admin");
      await store.changeMemberRole({ userId: NEWU, orgId: ORG_A }, ALICE, "owner");
      await store.removeMember({ userId: NEWU, orgId: ORG_A }, NEWU); // owner leaves; Alice is still owner
      expect((await store.listMemberships(NEWU))).toEqual([]);
      const ev = await admin.query(`select event_type from public.outreach_events where org_id = $1 and event_type like 'member_%'`, [ORG_A]);
      expect(ev.rows.map(r => r.event_type)).toEqual(expect.arrayContaining(["member_role_changed", "member_left"]));
    });

    it("deleting an organization still cascades through the last-owner guard", async () => {
      const ORG_C = "cccccccc-0000-4000-8000-00000000000c";
      const c = await admin.connect();
      await seedOrg(c, { orgId: ORG_C, name: "Org C", slug: "org-c", businessName: "Org C", ownerId: BOB });
      c.release();
      await store.createInvitation({ userId: BOB, orgId: ORG_C }, { email: "z@c.test", role: "staff", tokenHash: hashInviteToken(newInviteToken()), expiresAt: inTwoDays() });
      await admin.query(`delete from public.organizations where id = $1`, [ORG_C]);
      expect((await admin.query(`select 1 from public.memberships where org_id = $1`, [ORG_C])).rowCount).toBe(0);
      expect((await admin.query(`select 1 from public.invitations where org_id = $1`, [ORG_C])).rowCount).toBe(0);
    });
  });
  describe("promotions & settings", () => {
    const A = { userId: ALICE, orgId: ORG_A };
    const input = { schedule: "weekly" as const, days: [4, 5], title: "Weekend glass", description: "", discountType: "percent" as const, discountValue: 10,
      categories: ["glass"], productIds: [] as string[], startsOn: "2026-11-01", endsOn: null, active: true };

    it("seeds promotions and settings; product ids map to the org's catalog", async () => {
      const deals = await store.listDeals(A);
      expect(deals.map(d => d.title)).toEqual(expect.arrayContaining(["Mellow Monday", "Cigar Friday"]));
      const thursday = deals.find(d => d.title === "Throwback Thursday")!;
      const catalog = await store.listCatalog(A);
      expect(thursday.productIds.map(id => catalog.find(p => p.id === id)?.brand).sort()).toEqual(["Elf Bar", "Geek Bar"]);
      expect(await store.getSettings(A)).toMatchObject({ storeName: "Cloud 9 Smoke Shop", smsSignature: "-Cloud 9" });
    });

    it("date-range promotions round-trip and the DB enforces their dates", async () => {
      const r = await store.createDeal(A, { ...input, schedule: "range", days: [0, 1, 2, 3, 4, 5, 6], startsOn: "2026-11-20", endsOn: "2026-12-31" });
      expect(r).toMatchObject({ schedule: "range", days: [0, 1, 2, 3, 4, 5, 6], startsOn: "2026-11-20", endsOn: "2026-12-31" });
      await expect(admin.query(`update public.deals set ends_on = null where id = $1`, [r.id])).rejects.toThrow(/deals_range_dates_check/);
      await expect(admin.query(`update public.deals set schedule = 'monthly' where id = $1`, [r.id])).rejects.toThrow(/deals_schedule_check/);
      expect((await store.listDeals(A)).some(d => d.id === r.id && d.schedule === "range")).toBe(true);
      await store.deleteDeal(A, r.id);
    });

    it("owner CRUD round-trips; other orgs and staff are blocked by RLS", async () => {
      const d = await store.createDeal(A, input);
      expect(d).toMatchObject({ days: [4, 5], startsOn: "2026-11-01", endsOn: null, active: true });
      expect((await store.updateDeal(A, d.id, { ...input, active: false })).active).toBe(false);
      await expect(store.updateDeal({ userId: BOB, orgId: ORG_B }, d.id, input)).rejects.toMatchObject({ code: "not_found" });
      expect((await asUser(BOB, `select * from public.deals where org_id = $1`, [ORG_A])).rowCount).toBe(0);
      expect((await asUser(STAFF, `update public.deals set active = true where id = $1`, [d.id])).rowCount).toBe(0);
      await expect(asUser(STAFF, `insert into public.deals (org_id, days, title, discount_type, discount_value) values ($1, '{1}', 'x', 'percent', 5)`, [ORG_A]))
        .rejects.toThrow(/row-level security/);
      await expect(asUser(ALICE, `insert into public.deals (org_id, days, title, discount_type, discount_value) values ($1, '{9}', 'x', 'percent', 5)`, [ORG_A]))
        .rejects.toThrow(/check constraint/);
      await store.deleteDeal(A, d.id);
      await expect(store.deleteDeal(A, d.id)).rejects.toMatchObject({ code: "not_found" });
    });

    it("settings upsert is owner/admin only and readable by members", async () => {
      const next = { storeName: "Shop A+", emailSignature: "A\nB", smsSignature: "-A", defaultChannel: "email" as const, maxDiscountPercent: 15, aiModel: "gpt-5-mini",
        brandVoice: { preset: "premium" as const, emoji: true, signOff: "Cheers", about: "Lounge" }, smsCooldownDays: 7, emailCooldownDays: 14 };
      expect(await store.updateSettings(A, next)).toEqual(next);
      await expect(asUser(ALICE, `update public.org_settings set sms_cooldown_days = -1 where org_id = $1`, [ORG_A])).rejects.toThrow(/check constraint/);
      await expect(asUser(ALICE, `update public.org_settings set brand_voice = '{"preset":"edgy"}' where org_id = $1`, [ORG_A])).rejects.toThrow(/check constraint/);
      expect((await asUser(STAFF, `select store_name from public.org_settings where org_id = $1`, [ORG_A])).rows[0].store_name).toBe("Shop A+");
      expect((await asUser(STAFF, `update public.org_settings set store_name = 'X' where org_id = $1`, [ORG_A])).rowCount).toBe(0);
      expect((await asUser(BOB, `select 1 from public.org_settings where org_id = $1`, [ORG_A])).rowCount).toBe(0);
      await expect(asUser(ALICE, `update public.org_settings set sms_signature = 'a' || chr(10) || 'b' where org_id = $1`, [ORG_A])).rejects.toThrow(/check constraint/);
    });

    it("suggestion drafts record the deal used", async () => {
      const id = opp(ORG_A, "cust_0002");
      const deal = (await store.listDeals(A)).find(d => d.title === "Cigar Friday")!;
      await store.saveSuggestion(A, id, { title: "t", reasoning: "r", channel: "sms", message: "m", subject: null, source: "rules", model: "rules",
        deal: { id: deal.id, title: deal.title, day: 4, discountLabel: "20% off" }, reasons: [], segment: "loyal", sendAt: null });
      const r = await admin.query(`select deal_id from public.outreach_drafts where opportunity_id = $1 order by created_at desc limit 1`, [id]);
      expect(r.rows[0].deal_id).toBe(deal.id);
    });
  });
  describe("opt-outs & replies", () => {
    const A = { userId: ALICE, orgId: ORG_A };
    beforeAll(async () => {
      // Earlier tests reset/alter suppressions; re-seed (idempotent) to restore the demo opt-outs.
      await admin.query(`delete from public.suppressions where org_id = $1`, [ORG_A]);
      const c = await admin.connect();
      await seedOrg(c, { orgId: ORG_A, name: "Org A", slug: "org-a", businessName: "Shop A", ownerId: ALICE });
      c.release();
    });
    it("seeded per-channel opt-outs are listed with masked contacts, filter, search and paging", async () => {
      const all = await store.listOptOuts(A, { limit: 10, offset: 0 });
      expect(all.total).toBe(3);
      expect(all.items[0]).toMatchObject({ customerName: "Chris Ortiz", channel: "sms", source: "sms_stop", contact: "+15***08" });
      expect((await store.listOptOuts(A, { channel: "email", limit: 10, offset: 0 })).items.map(i => i.customerName)).toEqual(["Hannah Wright"]);
      expect((await store.listOptOuts(A, { search: "fisch", limit: 10, offset: 0 })).total).toBe(1);
      expect((await store.listOptOuts(A, { search: "%", limit: 10, offset: 0 })).total).toBe(0);
      expect((await store.listOptOuts(A, { limit: 1, offset: 2 })).items).toHaveLength(1);
      expect((await store.listOptOuts({ userId: BOB, orgId: ORG_A }, { limit: 10, offset: 0 })).total).toBe(0);
    });

    it("addOptOut/removeOptOut are idempotent, per channel and audited", async () => {
      expect(await store.addOptOut(ORG_A, "sms", "+1 555 555 0003", "sms_stop")).toEqual({ created: true });
      expect(await store.addOptOut(ORG_A, "sms", "+15555550003", "sms_stop")).toEqual({ created: false });
      expect(await store.isSuppressed(ORG_A, "sms", "+15555550003")).toBe(true);
      expect(await store.isSuppressed(ORG_A, "email", "priya@example.com")).toBe(false);
      expect(await store.removeOptOut(ORG_A, "sms", "+15555550003", "sms_start")).toEqual({ removed: true });
      expect(await store.removeOptOut(ORG_A, "sms", "+15555550003", "sms_start")).toEqual({ removed: false });
      const ev = await admin.query(`select event_type from public.outreach_events where org_id = $1 and event_type in ('opted_out','opted_in')
        and details->>'source' in ('sms_stop', 'sms_start')`, [ORG_A]);
      expect(ev.rows.map(r => r.event_type).sort()).toEqual(["opted_in", "opted_out"]);
      expect((await asUser(ALICE, `update public.suppressions set source = 'bogus'`)).rowCount).toBe(0);
    });

    it("consent history, re-opt-in requests and their RLS", async () => {
      await store.addOptOut(ORG_A, "email", "priya@example.com", "email_unsubscribe", { requestId: "req-1" });
      const sid = (await admin.query(`select id from public.suppressions where org_id = $1 and channel = 'email' and value = 'priya@example.com'`, [ORG_A])).rows[0].id;
      const entry = (await store.listOptOuts(A, { channel: "email", limit: 100, offset: 0 })).items.find(i => i.id === sid)!;
      expect(entry.reoptIn).toBeNull();
      expect((await store.listConsentEvents(A, entry.id))[0]).toMatchObject({ event: "opt_out", source: "email_unsubscribe", requestId: "req-1" });
      await expect(store.listConsentEvents({ userId: BOB, orgId: ORG_A }, entry.id)).rejects.toBeTruthy();
      await expect(store.createReoptInRequest({ userId: STAFF, orgId: ORG_A }, entry.id)).rejects.toMatchObject({ code: "forbidden" });
      const { request, recipient } = await store.createReoptInRequest(A, entry.id, { actorId: ALICE, requestId: "req-2" });
      expect(recipient).toBe("priya@example.com");
      await expect(store.createReoptInRequest(A, entry.id)).rejects.toMatchObject({ reason: "reoptin_pending" });
      expect((await store.listOptOuts(A, { channel: "email", limit: 100, offset: 0 })).items.find(i => i.id === sid)!.reoptIn).toMatchObject({ status: "pending" });
      // RLS: staff can't create requests or delete opt-outs; nobody can rewrite consent history.
      await expect(asUser(STAFF, `insert into public.reoptin_requests (org_id, channel, value, requested_by) values ($1, 'email', 'x@y.z', $2)`, [ORG_A, STAFF])).rejects.toThrow();
      expect((await asUser(ALICE, `delete from public.suppressions where org_id = $1`, [ORG_A]).catch(e => e)).message ?? "").toMatch(/permission denied/);
      await expect(admin.query(`delete from public.consent_events where org_id = $1`, [ORG_A])).rejects.toThrow(/append-only/);
      expect((await asUser(BOB, `select * from public.consent_events where org_id = $1`, [ORG_A])).rowCount).toBe(0);
      expect((await store.getReoptInRequest(request.id))?.status).toBe("pending");
      expect(await store.confirmReoptIn(request.id, { requestId: "req-3" })).toEqual({ removed: true });
      expect(await store.confirmReoptIn(request.id)).toEqual({ removed: false });
      expect((await store.getReoptInRequest(request.id))?.status).toBe("confirmed");
      const ev = await admin.query(`select event, source, request_id from public.consent_events where org_id = $1 and value = 'priya@example.com' order by created_at`, [ORG_A]);
      expect(ev.rows.map(r => `${r.event}:${r.source}:${r.request_id}`)).toEqual(["opt_out:email_unsubscribe:req-1", "reoptin_requested:store_request:req-2", "opt_in:reoptin_link:req-3"]);
    });

    it("threads: seeded, unread, mark read, reply blocked on opt-out, inbound via privileged path only", async () => {
      const convs = await store.listConversations(A, 50);
      expect(convs[0]).toMatchObject({ customerName: "Jamal Carter", unreadCount: 1, channel: "sms" });
      expect(await store.unreadCount(A)).toBe(4);
      expect(await store.listConversations({ userId: BOB, orgId: ORG_A }, 50)).toEqual([]);
      const jamal = convs[0];
      await store.markRead(A, jamal.id);
      expect(await store.unreadCount(A)).toBe(3);
      const reply = await store.createReply(A, jamal.id, { body: "Holding 3 for you -Cloud 9", subject: null });
      expect(reply).toMatchObject({ channel: "sms", recipient: "+15555550002", replyToken: null, message: { status: "sending" } });
      await store.updateMessageStatus(reply.message.id, "sent", "SM123");
      const t = (await store.getThread(A, jamal.id))!;
      expect(t.messages.at(-1)).toMatchObject({ direction: "outbound", status: "sent", sentBy: ALICE });
      const chris = convs.find(c => c.customerName === "Chris Ortiz")!;
      await expect(store.createReply(A, chris.id, { body: "x", subject: null })).rejects.toMatchObject({ code: "suppressed" });
      await expect(asUser(ALICE, `insert into public.messages (org_id, conversation_id, direction, status, body) values ($1,$2,'inbound','received','fake')`, [ORG_A, jamal.id]))
        .rejects.toThrow(/row-level security/);
      await store.appendMessage(ORG_A, "sms", "+15555550002", { direction: "inbound", kind: "message", status: "received", body: "thanks!" });
      expect((await store.listConversations(A, 1))[0]).toMatchObject({ id: jamal.id, unreadCount: 1, lastMessagePreview: "thanks!" });
    });

    it("email reply tokens resolve to the thread; deck sends are recorded", async () => {
      const sarah = (await store.listConversations(A, 50)).find(c => c.customerName === "Sarah Mitchell")!;
      const r = await store.createReply(A, sarah.id, { body: "Hi", subject: "Re: x" });
      expect(r.replyToken).toMatch(/^[A-Za-z0-9_-]{24}$/);
      expect(await store.findReplyToken(r.replyToken!)).toEqual({ orgId: ORG_A, channel: "email", contact: "sarah@example.com" });
      expect(await store.getOutboundMessage(r.message.id)).toMatchObject({ channel: "email" });
      const id = opp(ORG_A, "cust_0006");
      const { delivery } = await store.createDelivery(A, id, { channel: "email", recipient: "tyler@example.com", message: "Hi Tyler", subject: "s", idempotencyKey: "deck-key-0001" });
      expect((await store.getDelivery(delivery.id))!.replyToken).toMatch(/^[A-Za-z0-9_-]{24}$/);
      await store.updateDelivery(delivery.id, "sent", { providerMessageId: "p1" });
      const tyler = (await store.listConversations(A, 50)).find(c => c.customerName === "Tyler Nguyen")!;
      expect((await store.getThread(A, tyler.id))!.messages[0]).toMatchObject({ body: "Hi Tyler", status: "sent" });
      expect(await store.orgDisplayName(ORG_A)).toBe("Shop A+"); // set by the settings test above
    });
  });

  describe("cost & performance metrics", () => {
    const A = { userId: ALICE, orgId: ORG_A }, S = { userId: STAFF, orgId: ORG_A }, B = { userId: BOB, orgId: ORG_B };
    it("demo rows are seeded; ai_usage is owner/admin-only; sends/purchases are org-scoped; members can't forge demo rows", async () => {
      expect((await store.listSends(A, "2000-01-01")).filter(s => s.isDemo).length).toBeGreaterThan(300);
      expect((await store.listPurchaseRows(A, "2000-01-01")).some(p => p.isDemo && p.category)).toBe(true);
      expect((await store.listAiUsage(A, "2000-01-01")).length).toBeGreaterThan(300);
      await expect(store.listAiUsage(S, "2000-01-01")).rejects.toMatchObject({ code: "forbidden" });
      expect((await asUser(STAFF, `select count(*)::int n from public.ai_usage`)).rows[0].n).toBe(0);
      expect((await asUser(BOB, `select count(*)::int n from public.outreach_sends where org_id = $1`, [ORG_A])).rows[0].n).toBe(0);
      await expect(asUser(STAFF, `insert into public.ai_usage (org_id, actor_id, model, provider, price_version, is_demo) values ($1,$2,'x','rules','v',true)`, [ORG_A, STAFF])).rejects.toThrow();
      await expect(asUser(BOB, `insert into public.ai_usage (org_id, actor_id, model, provider, price_version) values ($1,$2,'x','rules','v')`, [ORG_A, BOB])).rejects.toThrow();

      const opp = (await store.listQueue(S, 50)).items[0];
      await store.recordAiUsage(S, { opportunityId: opp.id, model: "gpt-4o-mini", provider: "openai", inputTokens: 700, outputTokens: 150, costUsd: 0.000195, priceVersion: "t", dealId: null, dealTitle: "Vape Monday" });
      expect(await store.markAiUsageSent(S, opp.id, "sms")).toMatchObject({ model: "gpt-4o-mini", dealTitle: "Vape Monday" });
      await store.recordSend(S, { deliveryId: null, userLabel: "staff", customerId: opp.customer.id, channel: "sms", dealId: null, dealTitle: "Vape Monday", dealCategories: ["vape"], dealProductIds: [], model: "gpt-4o-mini" });
      const mine = (await store.listSends(A, "2000-01-01")).filter(s => !s.isDemo);
      expect(mine.at(-1)).toMatchObject({ userId: STAFF, model: "gpt-4o-mini", dealCategories: ["vape"] });
      expect((await store.listAiUsage(A, "2000-01-01")).at(-1)).toMatchObject({ ledToSend: true, sentChannel: "sms", costUsd: 0.000195 });
      expect((await store.listSends(B, "2000-01-01")).some(s => s.userId === STAFF)).toBe(false);
    });

    it("sms_costs: demo Twilio costs seeded; owner/admin read only; written only by the backend; estimate → actual price", async () => {
      expect((await store.listSmsCosts(A, "2000-01-01")).filter(c => c.isDemo && c.provider === "twilio").length).toBeGreaterThan(100);
      await expect(store.listSmsCosts(S, "2000-01-01")).rejects.toMatchObject({ code: "forbidden" });
      expect((await asUser(STAFF, `select count(*)::int n from public.sms_costs`)).rows[0].n).toBe(0);
      expect((await asUser(BOB, `select count(*)::int n from public.sms_costs where org_id = $1`, [ORG_A])).rows[0].n).toBe(0);
      await expect(asUser(ALICE, `insert into public.sms_costs (org_id, provider) values ($1,'twilio')`, [ORG_A])).rejects.toThrow();
      await expect(asUser(ALICE, `update public.sms_costs set price_usd = 0`)).rejects.toThrow();
      await store.recordSmsCost(ORG_A, { provider: "twilio", messageSid: "SMdbtest000000000001", segments: 2, priceUsd: 0.025, estimated: true });
      await admin.query(`update public.sms_costs set created_at = now() - interval '10 minutes' where message_sid = 'SMdbtest000000000001'`);
      expect((await store.listEstimatedSmsCosts({ olderThanIso: new Date().toISOString(), newerThanIso: "2000-01-01", limit: 10 })).map(x => x.messageSid)).toContain("SMdbtest000000000001");
      expect(await store.updateSmsCost("SMdbtest000000000001", { priceUsd: -0.0236, status: "delivered" })).toBe(true);
      expect(await store.updateSmsCost("SMnope", { status: "x" })).toBe(false);
      expect((await store.listSmsCosts(A, "2000-01-01")).find(c => c.messageSid === "SMdbtest000000000001")).toMatchObject({ priceUsd: 0.0236, estimated: false, segments: 2, status: "delivered" });
    });
  });

  describe("approval gate", () => {
    const CAROL = "ca201000-0000-4000-8000-000000000007", DAVE = "da7e0000-0000-4000-8000-000000000008";
    it("claim_pending_invitations auto-joins a matching unexpired invite (case-insensitive); strangers get nothing", async () => {
      await admin.query(`insert into auth.users (id, email) values ($1,'Carol@Shop.test'),($2,'dave@shop.test') on conflict do nothing`, [CAROL, DAVE]);
      await admin.query(`insert into public.invitations (org_id, email, role, token_hash, invited_by, expires_at) values ($1,'carol@shop.test','staff',repeat('c',64),$2, now() + interval '1 day')`, [ORG_A, ALICE]);
      await admin.query(`insert into public.invitations (org_id, email, role, token_hash, invited_by, created_at, expires_at) values ($1,'dave@shop.test','staff',repeat('d',64),$2, now() - interval '2 days', now() - interval '1 day')`, [ORG_A, ALICE]);
      expect(await store.claimPendingInvitations({ id: CAROL, email: "CAROL@shop.test" })).toBe(1);
      expect(await store.listMemberships(CAROL)).toMatchObject([{ orgId: ORG_A, role: "staff" }]);
      expect(await store.claimPendingInvitations({ id: CAROL, email: "carol@shop.test" })).toBe(0); // idempotent
      expect(await store.claimPendingInvitations({ id: DAVE, email: "dave@shop.test" })).toBe(0);    // expired
      expect(await store.listMemberships(DAVE)).toEqual([]);
      // With no membership, RLS shows nothing: the database itself denies unapproved users.
      expect((await asUser(DAVE, `select count(*)::int n from public.customers`)).rows[0].n).toBe(0);
      expect((await asUser(DAVE, `select count(*)::int n from public.invitations`)).rows[0].n).toBe(0);
      await expect(asUser(DAVE, `select public.claim_pending_invitations()`)).resolves.toBeTruthy();
    });
  });
  describe("contact cooldown", () => {
    it("contact cooldown: sent deliveries stamp last_sms_at, the queue honors per-channel windows, users can't rewrite history", async () => {
      const actor = { userId: STAFF, orgId: ORG_A };
      const id = opp(ORG_A, "cust_0004");
      const before = await store.getOpportunity(actor, id);
      expect(before!.customer).toMatchObject({ lastSmsAt: null, lastEmailAt: null });
      const { delivery } = await store.createDelivery(actor, id, { channel: "email", recipient: before!.customer.email!, message: "Hi", subject: "Hi", idempotencyKey: "cooldown-key-1" });
      await processDelivery(store, new ConsoleMessageProvider(() => {}), delivery.id);
      const after = await store.getOpportunity(actor, id);
      expect(after!.customer.lastEmailAt).toEqual(expect.any(String));
      expect(after!.customer.lastSmsAt).toBeNull();
      const custId = seedUuid(ORG_A, "customer:cust_0004");
      // Another actionable opportunity for the same customer, so the deck filter has something to hide.
      await admin.query(`update public.outreach_opportunities set status = 'pending' where id = $1`, [id]);
      await admin.query(`update public.customers set sms_consent = false where id = $1`, [custId]);
      const ids = async (c: { sms: number; email: number }) => (await store.listQueue(actor, 100, c)).items.map(o => o.id);
      expect(await ids({ sms: 0, email: 0 })).toContain(id);
      expect(await ids({ sms: 0, email: 7 })).not.toContain(id); // email cooling, SMS unreachable → skipped
      const { total } = await store.listQueue(actor, 1, { sms: 0, email: 7 });
      expect(total).toBe((await store.listQueue(actor, 100, { sms: 0, email: 7 })).items.length);
      await admin.query(`update public.customers set sms_consent = true where id = $1`, [custId]);
      expect(await ids({ sms: 0, email: 7 })).toContain(id); // SMS still open
      // Signed-in owners can't clear the history to dodge the window.
      await asUser(ALICE, `update public.customers set last_email_at = null where id = $1`, [custId]);
      expect((await admin.query(`select last_email_at from public.customers where id = $1`, [custId])).rows[0].last_email_at).not.toBeNull();
    });
  });
  describe("customer import + registered users", () => {
    const row = (n: number, phone: string, email: string) => ({ row: n, externalId: `ext-${n}`, firstName: `Imp${n}`, lastName: "Test", phone, email, location: "Burlington",
      age: null, lastPurchaseAt: null, lifetimeSpendCents: 1000, rewardsPoints: 5, lifetimeOrders: 12, customerSince: "2025-01-01" });
    it("owner/admin import with dedupe under RLS; staff can't import but can open a card; other orgs see nothing", async () => {
      const A = { userId: ALICE, orgId: ORG_A }, S = { userId: STAFF, orgId: ORG_A };
      const rows = [row(1, "+16095550901", "imp1@example.com"), row(2, "+15555550002", "dupe@example.com") /* Jamal's phone */];
      await expect(store.importCustomers(S, rows, { smsConsent: true, emailConsent: true, ageVerified: true })).rejects.toMatchObject({ code: "forbidden" });
      expect(await store.importCustomers(A, rows, { smsConsent: true, emailConsent: false, ageVerified: true })).toEqual({ inserted: 1, existing: 1 });
      expect(await store.importCustomers(A, rows, { smsConsent: true, emailConsent: false, ageVerified: true })).toEqual({ inserted: 0, existing: 2 });
      const keys = await store.customerKeys(A);
      expect(keys.externalIds.has("qv:ext-1") && keys.phones.has("6095550901") && keys.emails.has("imp1@example.com")).toBe(true);
      const list = await store.listCustomers(S, { search: "imp1", limit: 10, offset: 0 });
      expect(list.items).toEqual([expect.objectContaining({ name: "Imp1 Test", source: "csv" })]);
      expect((await store.listCustomers(S, { search: "0901", limit: 10, offset: 0 })).total).toBe(1);
      expect((await store.listCustomers({ userId: BOB, orgId: ORG_A }, { limit: 10, offset: 0 })).total).toBe(0);
      const cid = list.items[0].id;
      const oppId = await store.openCustomerCard(S, cid);
      const o = await store.getOpportunity(S, oppId!);
      expect(o).toMatchObject({ status: "pending", campaign: { id: "manual" }, customer: { smsConsent: true, emailConsent: false, ageVerified: true, lifetimeOrders: 12 } });
      const ev = await admin.query(`select channel, value, event, source, actor_id from public.consent_events where org_id = $1 and source = 'import_signup'`, [ORG_A]);
      expect(ev.rows).toEqual([{ channel: "sms", value: "+16095550901", event: "opt_in", source: "import_signup", actor_id: ALICE }]);
      // Staff can't forge an import_signup opt-in directly.
      await expect(asUser(STAFF, `insert into public.consent_events (org_id, channel, value, event, source, actor_id) values ($1,'sms','+1','opt_in','import_signup',$2)`, [ORG_A, STAFF]))
        .rejects.toThrow(/row-level security/);
      expect(await store.openCustomerCard(S, cid)).toBe(oppId); // reuses the open card
      await expect(store.openCustomerCard({ userId: BOB, orgId: ORG_A }, cid)).rejects.toMatchObject({ code: "forbidden" });
      expect(await store.openCustomerCard(S, "00000000-0000-4000-8000-000000000999")).toBeNull();
    });
  });
  describe("order history import", () => {
    it("imports new orders under RLS into purchases, dedupes by order id, links/creates customers, refreshes profiles", async () => {
      const A = { userId: ALICE, orgId: ORG_A }, S = { userId: STAFF, orgId: ORG_A };
      const { orders } = parseOrderCsv(readFileSync(new URL("../fixtures/orders-import.csv", import.meta.url), "utf8"));
      await expect(store.importOrders(S, orders)).rejects.toMatchObject({ code: "forbidden" });
      expect(await store.importOrders(A, orders)).toEqual({ inserted: 2, existing: 0, customersCreated: 1, unlinked: 1 });
      expect(await store.importOrders(A, orders)).toEqual({ inserted: 0, existing: 2, customersCreated: 0, unlinked: 1 });
      expect([...(await store.existingOrderIds(S, ["A-1001", "A-1002", "A-1003"]))].sort()).toEqual(["A-1001", "A-1002"]);
      const jamal = await store.getOpportunity(S, opp(ORG_A, "cust_0002"));
      expect(jamal!.customer.purchases[0]).toMatchObject({ name: "Padrón 1964 Maduro", category: "cigars", brand: "Padrón" });
      const riley = (await store.listCustomers(S, { search: "riley", limit: 5, offset: 0 })).items[0];
      expect(riley).toMatchObject({ name: "Riley Newcomer", source: "csv", lifetimeSpendCents: 99500 });
      const items = await admin.query(`select pi.quantity, pi.unit_price_cents from public.purchase_items pi join public.purchases p on p.id = pi.purchase_id
        where p.org_id = $1 and p.external_id = 'qv:A-1001' order by pi.unit_price_cents desc`, [ORG_A]);
      expect(items.rows).toEqual([{ quantity: 2, unit_price_cents: 1800 }, { quantity: 1, unit_price_cents: 999 }]);
      const ev = await admin.query(`select count(*)::int n from public.consent_events where org_id = $1 and source = 'import_signup' and value = '+16095550199'`, [ORG_A]);
      expect(ev.rows[0].n).toBe(1);
      expect(await store.existingOrderIds({ userId: BOB, orgId: ORG_A }, ["A-1001"])).toEqual(new Set());
    });
  });
  describe("bootstrap owner", () => {
    it("adds a confirmed auth user (case-insensitive) as owner of the oldest org; refuses unconfirmed/unknown", async () => {
      const JIM = "d1d1d1d1-0000-4000-8000-0000000000aa", UNV = "d1d1d1d1-0000-4000-8000-0000000000bb";
      await admin.query(`insert into auth.users (id, email, email_confirmed_at) values ($1,'MrDotJim@Gmail.com',now()),($2,'unverified@x.test',null)`, [JIM, UNV]);
      const oldest = (await admin.query(`select id from public.organizations order by created_at, id limit 1`)).rows[0].id;
      expect(await store.bootstrapOwner({ id: UNV, email: "unverified@x.test" }, "X")).toBe(false);
      expect(await store.bootstrapOwner({ id: JIM, email: "mrdotjim@gmail.com" }, "X")).toBe(true);
      expect(await store.listMemberships(JIM)).toEqual([expect.objectContaining({ orgId: oldest, role: "owner" })]);
      expect(await store.bootstrapOwner({ id: JIM, email: "mrdotjim@gmail.com" }, "X")).toBe(true);
      const c = await admin.connect();
      try {
        expect(await bootstrapOwner(c, { email: "nobody@x.test", orgName: "X" })).toEqual({ status: "no_user" });
        expect(await bootstrapOwner(c, { email: "UNVERIFIED@x.test", orgName: "X" })).toEqual({ status: "unverified" });
        expect(await bootstrapOwner(c, { email: "mrdotjim@gmail.com", orgName: "X" })).toEqual({ status: "already_member", orgId: oldest });
      } finally { c.release(); }
    });
    it("creates the default org when none exists", async () => {
      const c = await admin.connect();
      try {
        await c.query("begin");
        await c.query("delete from public.organizations");
        const r = await bootstrapOwner(c, { email: "mrdotjim@gmail.com", orgName: "Cloud 9" });
        expect(r).toMatchObject({ status: "added", orgCreated: true });
        const o = await c.query(`select name, business_name from public.organizations`);
        expect(o.rows).toEqual([{ name: "Cloud 9", business_name: "Cloud 9" }]);
      } finally { await c.query("rollback"); c.release(); }
    });
  });
});
