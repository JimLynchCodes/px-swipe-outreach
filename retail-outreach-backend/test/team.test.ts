import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { MemoryStore } from "../src/store/memory.js";
import { SupabaseInviteMailer } from "../src/team/mailer.js";
import { hashInviteToken } from "../src/team/tokens.js";
import { FakeInviteMailer, fakeSupabase, makeApp } from "./helpers.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const ADMIN = "22222222-2222-4222-8222-222222222222";
const STAFF = "33333333-3333-4333-8333-333333333333";
const NEWBIE = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";
const email = (id: string) => `${id.slice(0, 4)}@example.com`;
const ORG_ID = "99999999-9999-4999-8999-999999999999";
const DEMO_ORG = { name: "Acme Outfitters" };
const org = { orgId: ORG_ID, orgName: DEMO_ORG.name, businessName: null };

let app: FastifyInstance;
let store: MemoryStore;
let mailer: FakeInviteMailer;
let sign: (sub: string, o?: any) => Promise<string>;

beforeEach(async () => {
  store = new MemoryStore();
  store.addMembership(OWNER, { ...org, role: "owner" }, email(OWNER));
  store.addMembership(ADMIN, { ...org, role: "admin" }, email(ADMIN));
  store.addMembership(STAFF, { ...org, role: "staff" }, email(STAFF));
  mailer = new FakeInviteMailer();
  const fake = await fakeSupabase();
  sign = fake.sign;
  ({ app } = await makeApp({
    store, inviteMailer: mailer, authenticator: fake.authenticator,
    env: { APP_URL: "https://app.example.com", INVITE_RESEND_COOLDOWN_SECONDS: "60" }
  }));
});
afterEach(async () => { await app?.close(); });

async function as(user: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown, opts: { email?: string } = {}) {
  const token = await sign(user, opts.email ? { claims: { email: opts.email } } : {});
  return app.inject({ method, url, payload: payload as any, headers: { authorization: `Bearer ${token}`, "x-org-id": ORG_ID } });
}
const invite = (by: string, to: string, role = "staff") => as(by, "POST", "/api/team/invitations", { email: to, role });

describe("team members", () => {
  it("lists members with emails and roles for any member", async () => {
    const res = await as(STAFF, "GET", "/api/team/members");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.me).toEqual({ userId: STAFF, role: "staff" });
    expect(body.members.map((m: any) => m.email)).toEqual(expect.arrayContaining([email(OWNER), email(ADMIN), email(STAFF)]));
    expect(body.members[0].role).toBe("owner");
  });

  it("lets admins change staff<->admin but not touch owners or grant owner", async () => {
    expect((await as(ADMIN, "PATCH", `/api/team/members/${STAFF}`, { role: "admin" })).statusCode).toBe(200);
    const promote = await as(ADMIN, "PATCH", `/api/team/members/${STAFF}`, { role: "owner" });
    expect(promote.statusCode).toBe(403);
    expect(promote.json().code).toBe("insufficient_role");
    expect((await as(ADMIN, "PATCH", `/api/team/members/${OWNER}`, { role: "staff" })).statusCode).toBe(403);
    expect((await as(ADMIN, "DELETE", `/api/team/members/${OWNER}`)).statusCode).toBe(403);
  });

  it("forbids staff from managing others but lets anyone leave", async () => {
    expect((await as(STAFF, "PATCH", `/api/team/members/${ADMIN}`, { role: "staff" })).statusCode).toBe(403);
    expect((await as(STAFF, "DELETE", `/api/team/members/${ADMIN}`)).statusCode).toBe(403);
    expect((await as(STAFF, "DELETE", `/api/team/members/${STAFF}`)).statusCode).toBe(200);
    expect(store.events.at(-1)?.type).toBe("member_left");
  });

  it("never removes or demotes the last owner", async () => {
    const demote = await as(OWNER, "PATCH", `/api/team/members/${OWNER}`, { role: "admin" });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().code).toBe("last_owner");
    expect((await as(OWNER, "DELETE", `/api/team/members/${OWNER}`)).json().code).toBe("last_owner");
    // With a second owner it works.
    expect((await as(OWNER, "PATCH", `/api/team/members/${ADMIN}`, { role: "owner" })).statusCode).toBe(200);
    expect((await as(OWNER, "PATCH", `/api/team/members/${OWNER}`, { role: "admin" })).statusCode).toBe(200);
    expect(store.events.filter(e => e.type === "member_role_changed")).toHaveLength(2);
  });

  it("validates ids and roles and 404s unknown members", async () => {
    expect((await as(OWNER, "PATCH", `/api/team/members/nope`, { role: "admin" })).statusCode).toBe(400);
    expect((await as(OWNER, "PATCH", `/api/team/members/${STAFF}`, { role: "god" })).statusCode).toBe(400);
    expect((await as(OWNER, "DELETE", `/api/team/members/${OTHER}`)).statusCode).toBe(404);
  });
});

describe("invitations", () => {
  it("owner invites; email has an accept link; only the hash is stored; audit event written", async () => {
    const res = await invite(OWNER, "New.Person@Example.com", "admin");
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ emailSent: true, invitation: { email: "new.person@example.com", role: "admin", status: "pending", sendCount: 1 } });
    expect(body.acceptUrl).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/token/i);
    expect(mailer.sent[0]).toMatchObject({ email: "new.person@example.com", orgName: DEMO_ORG.name, role: "admin", inviterEmail: email(OWNER) });
    expect(mailer.sent[0].acceptUrl).toMatch(/^https:\/\/app\.example\.com\/invite\/accept\?token=[A-Za-z0-9_-]{43}$/);
    expect(await store.previewInvitation(hashInviteToken(mailer.lastToken()))).toMatchObject({ status: "pending" });
    expect(store.events.at(-1)).toMatchObject({ type: "invitation_created", actorId: OWNER, opportunityId: null });
  });

  it("role rules: staff can't invite or list; admins can't invite owners", async () => {
    expect((await invite(STAFF, "x@example.com")).statusCode).toBe(403);
    expect((await as(STAFF, "GET", "/api/team/invitations")).statusCode).toBe(403);
    expect((await invite(ADMIN, "x@example.com", "owner")).statusCode).toBe(403);
    expect((await invite(ADMIN, "x@example.com", "admin")).statusCode).toBe(201);
    expect((await invite(OWNER, "y@example.com", "owner")).statusCode).toBe(201);
  });

  it("rejects duplicates, existing members and bad input", async () => {
    await invite(OWNER, "dup@example.com");
    expect((await invite(OWNER, "DUP@example.com")).json().code).toBe("already_invited");
    expect((await invite(OWNER, email(STAFF))).json().code).toBe("already_member");
    expect((await invite(OWNER, "not-an-email")).statusCode).toBe(400);
    expect((await as(OWNER, "POST", "/api/team/invitations", { email: "a@b.co", role: "staff", extra: 1 })).statusCode).toBe(400);
  });

  it("replaces an expired pending invite instead of blocking", async () => {
    const first = (await invite(OWNER, "late@example.com")).json().invitation;
    store._patchInvitation(first.id, { expiresAt: new Date(Date.now() - 1000) });
    expect((await invite(OWNER, "late@example.com")).statusCode).toBe(201);
    const list = (await as(OWNER, "GET", "/api/team/invitations")).json().invitations;
    expect(list).toHaveLength(1);
    expect(list[0].id).not.toBe(first.id);
  });

  it("still creates the invite when email delivery fails", async () => {
    mailer.fail = true;
    const res = await invite(OWNER, "flaky@example.com");
    expect(res.statusCode).toBe(201);
    expect(res.json().emailSent).toBe(false);
  });

  it("resend rotates the token (old link dies), honours the cooldown", async () => {
    const inv = (await invite(OWNER, "again@example.com")).json().invitation;
    const oldToken = mailer.lastToken();
    expect((await as(OWNER, "POST", `/api/team/invitations/${inv.id}/resend`)).json().code).toBe("resend_cooldown");
    store._patchInvitation(inv.id, { lastSentAt: new Date(Date.now() - 120_000) });
    const res = await as(OWNER, "POST", `/api/team/invitations/${inv.id}/resend`);
    expect(res.statusCode).toBe(200);
    expect(res.json().invitation.sendCount).toBe(2);
    expect(mailer.lastToken()).not.toBe(oldToken);
    expect(await store.previewInvitation(hashInviteToken(oldToken))).toBeNull();
  });

  it("revoke hides the invite and kills the link; admins can't revoke owner invites", async () => {
    const ownerInv = (await invite(OWNER, "boss@example.com", "owner")).json().invitation;
    expect((await as(ADMIN, "DELETE", `/api/team/invitations/${ownerInv.id}`)).statusCode).toBe(403);
    const inv = (await invite(OWNER, "gone@example.com")).json().invitation;
    const token = mailer.lastToken();
    expect((await as(ADMIN, "DELETE", `/api/team/invitations/${inv.id}`)).statusCode).toBe(200);
    expect((await as(ADMIN, "DELETE", `/api/team/invitations/${inv.id}`)).statusCode).toBe(404);
    const accept = await as(NEWBIE, "POST", "/api/invitations/accept", { token }, { email: "gone@example.com" });
    expect(accept.statusCode).toBe(410);
    expect(accept.json().code).toBe("invitation_revoked");
  });
});

describe("accepting", () => {
  it("public preview works without a session and reveals nothing for bad tokens", async () => {
    await invite(OWNER, "newbie@example.com", "admin");
    const ok = await app.inject({ url: `/api/invitations/preview?token=${mailer.lastToken()}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().invitation).toMatchObject({ orgName: DEMO_ORG.name, email: "newbie@example.com", role: "admin", status: "pending" });
    expect((await app.inject({ url: `/api/invitations/preview?token=${"a".repeat(43)}` })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/invitations/preview?token=short` })).statusCode).toBe(400);
  });

  it("a brand-new user (no org yet) accepts with a matching email and becomes a member", async () => {
    await invite(OWNER, "newbie@example.com", "admin");
    const token = mailer.lastToken();
    const res = await as(NEWBIE, "POST", "/api/invitations/accept", { token }, { email: "NewBie@example.com" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, orgId: ORG_ID, role: "admin", alreadyMember: false });
    expect(res.json().memberships).toHaveLength(1);
    // Idempotent for the same user; refused for anyone else.
    expect((await as(NEWBIE, "POST", "/api/invitations/accept", { token }, { email: "newbie@example.com" })).json().alreadyMember).toBe(true);
    expect((await as(OTHER, "POST", "/api/invitations/accept", { token }, { email: "newbie@example.com" })).json().code).toBe("invitation_used");
    expect(store.events.some(e => e.type === "invitation_accepted" && e.actorId === NEWBIE)).toBe(true);
    expect((await as(OWNER, "GET", "/api/team/invitations")).json().invitations).toHaveLength(0);
  });

  it("refuses a different email, expired and unknown tokens, and anonymous callers", async () => {
    const inv = (await invite(OWNER, "newbie@example.com")).json().invitation;
    const token = mailer.lastToken();
    const wrong = await as(OTHER, "POST", "/api/invitations/accept", { token }, { email: "someone@else.com" });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().code).toBe("invitation_email_mismatch");
    expect((await app.inject({ method: "POST", url: "/api/invitations/accept", payload: { token } })).statusCode).toBe(401);
    expect((await as(NEWBIE, "POST", "/api/invitations/accept", { token: "b".repeat(43) }, { email: "newbie@example.com" })).statusCode).toBe(404);
    store._patchInvitation(inv.id, { expiresAt: new Date(Date.now() - 1) });
    const expired = await as(NEWBIE, "POST", "/api/invitations/accept", { token }, { email: "newbie@example.com" });
    expect(expired.statusCode).toBe(410);
    expect(expired.json().code).toBe("invitation_expired");
  });
});

describe("SupabaseInviteMailer", () => {
  const msg = { email: "a@example.com", orgName: "Org", role: "staff" as const, inviterEmail: null, acceptUrl: "https://app/invite/accept?token=t", expiresAt: new Date() };
  const make = (responses: Array<[number, unknown]>) => {
    const calls: Array<{ url: string; init: any }> = [];
    const fetchFn = (async (url: string, init: any) => {
      calls.push({ url, init });
      const [status, body] = responses.shift()!;
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { calls, mailer: new SupabaseInviteMailer({ supabaseUrl: "https://p.supabase.co", serviceRoleKey: "srk_1234567890abcdefghij", fetch: fetchFn }) };
  };

  it("invites new users with the accept URL as redirect, authenticating with the service key", async () => {
    const { calls, mailer } = make([[200, { id: "u" }]]);
    expect(await mailer.send(msg)).toEqual({ method: "invite" });
    expect(calls[0].url).toBe(`https://p.supabase.co/auth/v1/invite?redirect_to=${encodeURIComponent(msg.acceptUrl)}`);
    expect(calls[0].init.headers.Authorization).toBe("Bearer srk_1234567890abcdefghij");
    expect(JSON.parse(calls[0].init.body)).toMatchObject({ email: "a@example.com", data: { invited_to_org: "Org" } });
  });

  it("falls back to a magic link for existing users and surfaces other failures", async () => {
    const existing = make([[422, { error_code: "email_exists" }], [200, {}]]);
    expect(await existing.mailer.send(msg)).toEqual({ method: "magic_link" });
    expect(existing.calls[1].url).toContain("/auth/v1/otp?redirect_to=");
    expect(JSON.parse(existing.calls[1].init.body)).toMatchObject({ create_user: false });
    await expect(make([[500, {}]]).mailer.send(msg)).rejects.toThrow(/invite failed \(500/);
  });
});
