import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { SignJWT, generateKeyPair } from "jose";
import { DemoAuthenticator, SupabaseJwtAuthenticator, resolveOrg } from "../src/auth.js";
import { DEMO_ORG_ID, DEMO_USER_ID } from "../src/data/seed.js";
import { MemoryStore } from "../src/store/memory.js";
import { ISSUER, SUPABASE_URL, fakeSupabase, makeApp } from "./helpers.js";

let app: FastifyInstance;
afterEach(async () => { await app?.close(); });

const OTHER_USER = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";

describe("Supabase JWT auth middleware", () => {
  async function setup() {
    const sb = await fakeSupabase();
    const store = new MemoryStore();
    ({ app } = await makeApp({ authenticator: sb.authenticator, store }));
    return { ...sb, store };
  }

  it("rejects requests without a token (401 + WWW-Authenticate)", async () => {
    await setup();
    const r = await app.inject("/api/outreach/queue");
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ code: "unauthenticated" });
    expect(r.headers["www-authenticate"]).toContain("Bearer");
  });

  it("accepts a valid token and scopes data to the user's org", async () => {
    const { sign } = await setup();
    const r = await app.inject({ url: "/api/outreach/queue", headers: { authorization: `Bearer ${await sign(DEMO_USER_ID)}` } });
    expect(r.statusCode).toBe(200);
    expect(r.json().total).toBe(19);
  });

  it("rejects expired, wrong-audience, wrong-issuer and foreign-key tokens", async () => {
    const { sign } = await setup();
    const { privateKey: foreign } = await generateKeyPair("ES256");
    const cases = [
      [await sign(DEMO_USER_ID, { exp: Math.floor(Date.now() / 1000) - 60 }), "token_expired"],
      [await sign(DEMO_USER_ID, { aud: "anon" }), "invalid_token"],
      [await sign(DEMO_USER_ID, { iss: "https://evil.example/auth/v1" }), "invalid_token"],
      [await sign(DEMO_USER_ID, { key: foreign }), "invalid_token"],
      [await sign(DEMO_USER_ID, { claims: { role: "anon" } }), "invalid_token"],
      ["not.a.jwt", "invalid_token"]
    ] as const;
    for (const [token, code] of cases) {
      const r = await app.inject({ url: "/api/outreach/queue", headers: { authorization: `Bearer ${token}` } });
      expect(r.statusCode, code).toBe(401);
      expect(r.json().code).toBe(code);
    }
  });

  it("returns 403 for a signed-in user with no membership, and for an org they don't belong to", async () => {
    const { sign, store } = await setup();
    const stranger = await sign(OTHER_USER);
    expect((await app.inject({ url: "/api/outreach/queue", headers: { authorization: `Bearer ${stranger}` } })).json().code).toBe("not_approved");
    store.addMembership(OTHER_USER, { orgId: OTHER_ORG, orgName: "Other", businessName: null, role: "owner" });
    const r = await app.inject({ url: "/api/outreach/queue", headers: { authorization: `Bearer ${stranger}`, "x-org-id": DEMO_ORG_ID } });
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe("not_a_member");
  });

  it("/api/me works without an org header and lists memberships", async () => {
    const { sign, store } = await setup();
    store.addMembership(OTHER_USER, { orgId: OTHER_ORG, orgName: "Other", businessName: null, role: "staff" });
    const r = await app.inject({ url: "/api/me", headers: { authorization: `Bearer ${await sign(OTHER_USER)}` } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ user: { id: OTHER_USER }, memberships: [{ orgId: OTHER_ORG }], authMode: "supabase" });
  });

  describe("approval gate (Team list only)", () => {
    const STRANGER = "22222222-2222-4222-8222-222222222222";
    const as = (t: string) => ({ authorization: `Bearer ${t}` });
    const invite = (store: MemoryStore, email: string, o: { expiresAt?: Date } = {}) =>
      store.createInvitation({ userId: DEMO_USER_ID, orgId: DEMO_ORG_ID },
        { email, role: "staff", tokenHash: Math.random().toString(16).slice(2).padEnd(64, "0").slice(0, 64), expiresAt: o.expiresAt ?? new Date(Date.now() + 86_400_000) });

    it("a signed-in stranger gets 403 not_approved with the exact message on every API route, /api/me included", async () => {
      const { sign } = await setup();
      const t = await sign(STRANGER, { claims: { email: "Nobody@Example.com" } });
      for (const url of ["/api/me", "/api/outreach/queue", "/api/settings", "/api/opt-outs", "/api/metrics/performance", "/api/team"]) {
        const r = await app.inject({ url, headers: as(t) });
        expect(r.statusCode, url).toBe(403);
        expect(r.json()).toMatchObject({ code: "not_approved",
          error: "Nobody@Example.com has not been approved for this application. If this is in error, please contact your administrator." });
      }
    });

    it("a pending invitee who signs in directly is auto-joined (case-insensitive email)", async () => {
      const { sign, store } = await setup();
      await invite(store, "new.hire@example.com");
      const r = await app.inject({ url: "/api/me", headers: as(await sign(STRANGER, { claims: { email: "New.Hire@EXAMPLE.com" } })) });
      expect(r.statusCode).toBe(200);
      expect(r.json().memberships).toMatchObject([{ orgId: DEMO_ORG_ID, role: "staff" }]);
      const inv = (await store.listInvitations({ userId: DEMO_USER_ID, orgId: DEMO_ORG_ID })).find(i => i.email === "new.hire@example.com");
      expect(inv === undefined || inv.status === "accepted").toBe(true); // no longer pending
    });

    it("expired or revoked invites and removed members do not get in", async () => {
      const { sign, store } = await setup();
      const exp = await invite(store, "late@example.com");
      store._patchInvitation(exp.id, { expiresAt: new Date(Date.now() - 1000) });
      expect((await app.inject({ url: "/api/me", headers: as(await sign(STRANGER, { claims: { email: "late@example.com" } })) })).statusCode).toBe(403);
      const rev = await invite(store, "revoked@example.com");
      await store.revokeInvitation({ userId: DEMO_USER_ID, orgId: DEMO_ORG_ID }, rev.id);
      expect((await app.inject({ url: "/api/me", headers: as(await sign(STRANGER, { claims: { email: "revoked@example.com" } })) })).statusCode).toBe(403);
      await invite(store, "temp@example.com");
      const t = await sign(OTHER_USER, { claims: { email: "temp@example.com" } });
      expect((await app.inject({ url: "/api/me", headers: as(t) })).statusCode).toBe(200);
      await store.removeMember({ userId: DEMO_USER_ID, orgId: DEMO_ORG_ID }, OTHER_USER);
      expect((await app.inject({ url: "/api/me", headers: as(t) })).json().code).toBe("not_approved"); // accepted invite alone isn't access
    });
  });

  it("verifies legacy HS256 tokens with SUPABASE_JWT_SECRET and rejects alg confusion", async () => {
    const secret = "x".repeat(40);
    const auth = new SupabaseJwtAuthenticator({ supabaseUrl: SUPABASE_URL, audience: "authenticated", jwtSecret: secret });
    const token = await new SignJWT({ role: "authenticated" }).setProtectedHeader({ alg: "HS256" })
      .setSubject(DEMO_USER_ID).setIssuer(ISSUER).setAudience("authenticated").setExpirationTime("1m")
      .sign(new TextEncoder().encode(secret));
    await expect(auth.authenticate(`Bearer ${token}`)).resolves.toMatchObject({ id: DEMO_USER_ID });
    const hs512 = await new SignJWT({ role: "authenticated" }).setProtectedHeader({ alg: "HS512" })
      .setSubject(DEMO_USER_ID).setIssuer(ISSUER).setAudience("authenticated").setExpirationTime("1m")
      .sign(new TextEncoder().encode(secret));
    await expect(auth.authenticate(`Bearer ${hs512}`)).rejects.toMatchObject({ code: "invalid_token" });
  });

  it("health endpoints stay public", async () => {
    await setup();
    expect((await app.inject("/health/live")).statusCode).toBe(200);
    expect((await app.inject("/health/ready")).statusCode).toBe(200);
  });
});

describe("demo auth and org resolution", () => {
  it("demo authenticator refuses to exist in production", () => {
    expect(() => new DemoAuthenticator(DEMO_USER_ID, "production")).toThrow();
  });

  it("resolveOrg honours X-Org-Id only for members and requires a choice when ambiguous", () => {
    const ms = [
      { orgId: "a", orgName: "A", businessName: null, role: "owner" as const },
      { orgId: "b", orgName: "B", businessName: "Bee", role: "staff" as const }
    ];
    expect(resolveOrg(ms, "b")).toEqual({ orgId: "b", role: "staff", businessName: "Bee", orgName: "B" });
    expect(() => resolveOrg(ms, undefined)).toThrow(expect.objectContaining({ status: 400, code: "org_required" }));
    expect(() => resolveOrg(ms, "c")).toThrow(expect.objectContaining({ status: 403 }));
    expect(resolveOrg([ms[0]], undefined).orgId).toBe("a");
  });
});
