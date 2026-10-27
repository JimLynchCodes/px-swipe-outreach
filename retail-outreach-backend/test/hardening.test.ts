import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ConfigError, loadConfig } from "../src/config.js";
import { makeApp } from "./helpers.js";
import type { OutreachStore } from "../src/store/types.js";
import { MemoryStore } from "../src/store/memory.js";

let app: FastifyInstance;
afterEach(async () => { await app?.close(); });

const PROD_OK = {
  NODE_ENV: "production", AUTH_MODE: "supabase", SUPABASE_URL: "https://abc.supabase.co",
  DATA_STORE: "postgres", DATABASE_URL: "postgres://u:p@db:5432/postgres", CORS_ORIGIN: "https://app.example.com"
};

describe("config validation (fail fast)", () => {
  it("accepts a correct production config and disables demo reset", () => {
    const c = loadConfig(PROD_OK);
    expect(c.ENABLE_DEMO_RESET).toBe(false);
    expect(c.CORS_ORIGIN).toEqual(["https://app.example.com"]);
  });

  it.each([
    [{ AUTH_MODE: "demo" }, "AUTH_MODE"],
    [{ DATA_STORE: "memory" }, "DATA_STORE"],
    [{ CORS_ORIGIN: "*" }, "CORS_ORIGIN"],
    [{ CORS_ORIGIN: "http://app.example.com" }, "CORS_ORIGIN"],
    [{ ENABLE_DEMO_RESET: "true" }, "ENABLE_DEMO_RESET"],
    [{ SUPABASE_URL: "" }, "SUPABASE_URL"],
    [{ DATABASE_URL: "" }, "DATABASE_URL"],
    [{ SUPABASE_JWT_SECRET: "short" }, "SUPABASE_JWT_SECRET"]
  ])("rejects unsafe production config %j", (patch, field) => {
    expect(() => loadConfig({ ...PROD_OK, ...patch })).toThrow(ConfigError);
    expect(() => loadConfig({ ...PROD_OK, ...patch })).toThrow(field);
  });
});

describe("HTTP hardening", () => {
  it("assigns request ids, honours a sane incoming one, and returns them in errors", async () => {
    ({ app } = await makeApp());
    const a = await app.inject({ url: "/api/outreach/nope", headers: { "x-request-id": "trace-abc-123" } });
    expect(a.headers["x-request-id"]).toBe("trace-abc-123");
    expect(a.json()).toEqual({ error: "Opportunity not found", code: "not_found", requestId: "trace-abc-123" });
    const b = await app.inject({ url: "/health/live", headers: { "x-request-id": "bad id with spaces\n" } });
    expect(b.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("sets security headers and a strict CORS allowlist", async () => {
    ({ app } = await makeApp());
    const ok = await app.inject({ url: "/health/live", headers: { origin: "http://localhost:5173" } });
    expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(ok.headers["x-content-type-options"]).toBe("nosniff");
    expect(ok.headers["content-security-policy"]).toContain("default-src 'none'");
    const evil = await app.inject({ url: "/health/live", headers: { origin: "https://evil.example" } });
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rate limits sends per user", async () => {
    ({ app } = await makeApp({ env: { SEND_RATE_LIMIT_PER_MINUTE: "2" } }));
    const send = (i: number) => app.inject({ method: "POST", url: "/api/outreach/nope/send",
      payload: { channel: "sms", message: "hi", idempotencyKey: `key-0000000${i}` } });
    expect((await send(1)).statusCode).toBe(404);
    expect((await send(2)).statusCode).toBe(404);
    const limited = await send(3);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe("rate_limited");
  });

  it("readiness returns 503 when the database is down; liveness stays up", async () => {
    const store = new MemoryStore() as OutreachStore;
    store.ping = async () => { throw new Error("ECONNREFUSED"); };
    ({ app } = await makeApp({ store }));
    expect((await app.inject("/health/ready")).statusCode).toBe(503);
    expect((await app.inject("/health/live")).statusCode).toBe(200);
  });

  it("rejects oversized bodies and unknown fields", async () => {
    ({ app } = await makeApp());
    const big = await app.inject({ method: "POST", url: "/api/outreach/opp_0001/send",
      payload: { channel: "email", message: "x".repeat(70_000), idempotencyKey: "key-12345678" } });
    expect(big.statusCode).toBe(413);
    const extra = await app.inject({ method: "POST", url: "/api/outreach/opp_0001/suggestion", payload: { channel: "sms", orgId: "x" } });
    expect(extra.statusCode).toBe(400);
    expect(extra.json().code).toBe("invalid_request");
  });

  it("validates send payloads", async () => {
    ({ app } = await makeApp());
    const bad = [
      { channel: "sms", message: "", idempotencyKey: "key-12345678" },
      { channel: "sms", message: "hi", idempotencyKey: "short" },
      { channel: "sms", message: "hi", idempotencyKey: "has spaces in it" },
      { channel: "sms", message: "x".repeat(481), idempotencyKey: "key-12345678" },
      { channel: "pigeon", message: "hi", idempotencyKey: "key-12345678" }
    ];
    for (const payload of bad) {
      expect((await app.inject({ method: "POST", url: "/api/outreach/opp_0001/send", payload })).statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it("returns a JSON 404 for unknown routes", async () => {
    ({ app } = await makeApp());
    expect((await app.inject("/api/nope")).json()).toMatchObject({ code: "not_found" });
  });
});

describe("opt-out enforcement", () => {
  it("opt-out removes the card, blocks sends on that channel, and survives in the store", async () => {
    let sent = 0;
    ({ app } = await makeApp({ messenger: { name: "count", send: async () => { sent++; return { providerMessageId: "x" }; } } }));
    const r = await app.inject({ method: "POST", url: "/api/outreach/opp_0001/opt-out", payload: { channel: "sms" } });
    expect(r.json()).toMatchObject({ ok: true, channels: ["sms"] });
    expect((await app.inject("/api/outreach/queue")).json().total).toBe(19);
    const send = await app.inject({ method: "POST", url: "/api/outreach/opp_0001/send", payload: { channel: "sms", message: "hi", idempotencyKey: "key-12345678" } });
    expect(send.statusCode).toBe(422);
    expect(send.json().code).toBe("suppressed");
    const card = (await app.inject("/api/outreach/opp_0001")).json();
    expect(card.customer.contact.sms).toBe(false);
    expect(sent).toBe(0);
  });

  it("worker re-checks suppression before sending", async () => {
    const { processDelivery } = await import("../src/delivery.js");
    const store = new MemoryStore();
    const actor = { userId: (await import("../src/data/seed.js")).DEMO_USER_ID, orgId: (await import("../src/data/seed.js")).DEMO_ORG_ID };
    const { delivery } = await store.createDelivery(actor, "opp_0002", { channel: "sms", recipient: "+15555550002", message: "hi", subject: null, idempotencyKey: "key-abcdefgh" });
    await store.optOut(actor, "opp_0002", ["sms"], "opt_out");
    let sent = 0;
    const done = await processDelivery(store, { name: "x", send: async () => { sent++; return { providerMessageId: "x" }; } }, delivery.id);
    expect(done).toMatchObject({ status: "failed", error: "recipient_suppressed" });
    expect(sent).toBe(0);
  });
});
