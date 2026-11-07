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
    expect(sarah.segment).toBe("at_risk");
    expect(sarah.customer).toMatchObject({
      displayName: "Sarah M.", age: 34, location: "Main St", ageVerified: true,
      storesShopped: ["Main St", "Eastside"], lifetimeSpendCents: 8999 + 4500 + 3500 + 41000,
      daysSinceLastPurchase: 58, itemsPurchased: 3, contact: { sms: true, email: true, preferredChannel: "sms", blockedReason: null },
      profile: { favoriteCategories: ["cbd"], favoriteBrands: ["Charlotte's Web", "Cornbread Hemp"], visitsPerMonth: 1, avgBasketCents: 9800, preferredDay: 0, preferredTime: "evening" }
    });
    expect(sarah.lastPurchase).toMatchObject({ name: "Charlotte's Web CBD Oil 1500mg", brand: "Charlotte's Web", priceCents: 8999, daysAgo: 58, alsoPurchased: ["Cornbread Hemp Gummies 30ct", "Koi CBD Gummies 20ct"] });
    expect(sarah.recentItems).toHaveLength(3);
    // Unverified-age customer can't be contacted on any channel
    const ryan = body.items.find((i: any) => i.customer.firstName === "Ryan");
    expect(ryan.customer.contact).toMatchObject({ sms: false, email: false, blockedReason: "age_unverified" });
    expect(JSON.stringify(body)).not.toMatch(/@example\.com|\+1555/);
  });

  it("generates a deal-based suggestion with signature and opt-out for SMS and email", async () => {
    ({ app } = await makeApp());
    const sms = (await app.inject({ method: "POST", url: "/api/outreach/opp_0001/suggestion", payload: { channel: "sms" } })).json();
    expect(sms.suggestion).toMatchObject({
      title: "Bring them in for Mellow Monday (15% off)", channel: "sms", subject: null, source: "rules", segment: "at_risk",
      deal: { title: "Mellow Monday", day: 0, discountLabel: "15% off" }
    });
    expect(sms.suggestion.reasons.join(" ")).toMatch(/At risk: 58 days/);
    expect(sms.suggestion.message).toBe("Hi Sarah, it's Cloud 9 Smoke Shop. Haven't seen you in a bit! Monday only: Mellow Monday. 15% off all CBD oils and gummies. 21+ w/ ID. -Cloud 9\nReply STOP to opt out.");
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
    // The opt-out line is enforced server-side even when staff edit it away.
    expect(messenger.sent).toEqual([{ channel: "sms", recipient: "+15555550001", message: "Hi Sarah! Edited.\nReply STOP to opt out.", subject: null }]);

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
    expect(d).toMatchObject({ status: "failed", error: "down", subject: "A note from Cloud 9 Smoke Shop" });
  });

  it("dev reset restores the deck", async () => {
    ({ app } = await makeApp());
    await app.inject({ method: "POST", url: "/api/outreach/opp_0001/skip" });
    await app.inject({ method: "POST", url: "/api/dev/reset" });
    expect((await app.inject("/api/outreach/queue")).json().total).toBe(20);
  });
});
