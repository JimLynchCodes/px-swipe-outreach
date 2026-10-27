import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeApp } from "./helpers.js";
import { ConsoleMessageProvider } from "../src/providers/messaging.js";

let app: FastifyInstance;
afterEach(async () => { await app?.close(); });

describe("outreach API", () => {
  it("serves health without auth", async () => {
    ({ app } = await makeApp());
    const r = await app.inject("/health");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, store: "memory", ai: "rules" });
  });

  it("returns the 20-card deck with mockup fields and no raw contact details", async () => {
    ({ app } = await makeApp());
    const r = await app.inject("/api/outreach/queue");
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.total).toBe(20);
    expect(body.items).toHaveLength(20);
    const sarah = body.items[0];
    expect(sarah.customer).toMatchObject({
      displayName: "Sarah M.", age: 34, gender: "Female", location: "Downtown",
      storesShopped: ["Downtown", "Westside"], lifetimeSpendCents: 86000,
      daysSinceLastPurchase: 68, itemsPurchased: 3, contact: { sms: true, email: true, preferredChannel: "sms" }
    });
    expect(sarah.lastPurchase).toMatchObject({ name: "Leather Tote Bag", priceCents: 16000, daysAgo: 68, alsoPurchased: ["Wallet", "Scarf"] });
    expect(JSON.stringify(body)).not.toMatch(/@example\.com|\+1555/);
  });

  it("generates the win-back suggestion for SMS and email", async () => {
    ({ app } = await makeApp());
    const sms = (await app.inject({ method: "POST", url: "/api/outreach/opp_0001/suggestion", payload: { channel: "sms" } })).json();
    expect(sms.suggestion).toMatchObject({ title: "Welcome them back with 10% off", channel: "sms", subject: null, source: "rules" });
    expect(sms.suggestion.reasoning).toContain("over two months");
    expect(sms.suggestion.message).toContain("Enjoy 10% off your next purchase");
    const email = (await app.inject({ method: "POST", url: "/api/outreach/opp_0001/suggestion", payload: { channel: "email" } })).json();
    expect(email.suggestion.subject).toBeTruthy();
  });

  it("rejects a channel the customer cannot be reached on", async () => {
    ({ app } = await makeApp());
    // cust_0005 (opp_0005) has no phone
    const r = await app.inject({ method: "POST", url: "/api/outreach/opp_0005/suggestion", payload: { channel: "sms" } });
    expect(r.statusCode).toBe(422);
  });

  it("validates input", async () => {
    ({ app } = await makeApp());
    const r = await app.inject({ method: "POST", url: "/api/outreach/opp_0001/suggestion", payload: { channel: "fax" } });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: "Invalid request", code: "invalid_request" });
  });

  it("skips a card and removes it from the deck; second skip conflicts", async () => {
    ({ app } = await makeApp());
    expect((await app.inject({ method: "POST", url: "/api/outreach/opp_0001/skip" })).statusCode).toBe(200);
    const q = (await app.inject("/api/outreach/queue")).json();
    expect(q.total).toBe(19);
    expect(q.items[0].id).toBe("opp_0002");
    expect((await app.inject({ method: "POST", url: "/api/outreach/opp_0001/skip" })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/api/outreach/nope/skip" })).statusCode).toBe(404);
  });

  it("sends the edited message through the provider, idempotently", async () => {
    const messenger = new ConsoleMessageProvider(() => {});
    ({ app } = await makeApp({ messenger }));
    const payload = { channel: "sms", message: "Hi Sarah! Edited.", idempotencyKey: "key-12345678" };
    const r = await app.inject({ method: "POST", url: "/api/outreach/opp_0001/send", payload });
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe("sent");
    expect(messenger.sent).toEqual([{ channel: "sms", recipient: "+15555550001", message: "Hi Sarah! Edited.", subject: null }]);

    const again = await app.inject({ method: "POST", url: "/api/outreach/opp_0001/send", payload });
    expect(again.json()).toMatchObject({ duplicate: true, status: "sent" });
    expect(messenger.sent).toHaveLength(1);

    const other = await app.inject({ method: "POST", url: "/api/outreach/opp_0001/send", payload: { ...payload, idempotencyKey: "key-other-123" } });
    expect(other.statusCode).toBe(409);

    const deliveries = (await app.inject("/api/outreach/opp_0001/deliveries")).json().deliveries;
    expect(deliveries[0].recipient).toBe("+15***01");
    const metrics = (await app.inject("/api/metrics")).json();
    expect(metrics.deliveries).toEqual([{ status: "sent", channel: "sms", count: 1 }]);
  });

  it("marks the delivery failed and returns 502 when the provider throws", async () => {
    ({ app } = await makeApp({ messenger: { name: "boom", send: async () => { throw new Error("down"); } } }));
    const r = await app.inject({ method: "POST", url: "/api/outreach/opp_0001/send", payload: { channel: "email", message: "Hi", idempotencyKey: "key-12345678" } });
    expect(r.statusCode).toBe(502);
    const d = (await app.inject("/api/outreach/opp_0001/deliveries")).json().deliveries[0];
    expect(d).toMatchObject({ status: "failed", error: "down", subject: "A note from our store" });
  });

  it("dev reset restores the deck", async () => {
    ({ app } = await makeApp());
    await app.inject({ method: "POST", url: "/api/outreach/opp_0001/skip" });
    await app.inject({ method: "POST", url: "/api/dev/reset" });
    expect((await app.inject("/api/outreach/queue")).json().total).toBe(20);
  });
});
