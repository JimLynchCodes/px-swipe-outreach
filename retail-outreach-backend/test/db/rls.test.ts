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
});
