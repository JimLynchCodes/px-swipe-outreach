import { describe, expect, it } from "vitest";
import { makeApp } from "./helpers.js";
import { MemoryStore } from "../src/store/memory.js";
import { createMessageProvider, smsSegments, twilioPriceUsd, TwilioSmsProvider, type TwilioMessage } from "../src/providers/messaging.js";
import { reconcileSmsCosts } from "../src/metrics/smsCost.js";
import { costReport } from "../src/metrics/cost.js";
import { twilioSignature } from "../src/optout/twilio.js";
import { DEMO_ORG_ID, DEMO_USER_ID } from "../src/data/seed.js";
import { buildDemoMetrics } from "../src/data/demoMetrics.js";
import type { SmsCostRow } from "../src/metrics/types.js";

const TOKEN = "test-twilio-auth-token-123";
const API = "https://abc.trycloudflare.com";
const demoActor = { orgId: DEMO_ORG_ID, userId: DEMO_USER_ID };
const real = async (store: MemoryStore) => (await store.listSmsCosts(demoActor, "2000-01-01")).filter(x => !x.isDemo);

function fakeTwilio(created: Partial<TwilioMessage> = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const prices = new Map<string, TwilioMessage>();
  let n = 0;
  const client = {
    messages: { create: async (p: Record<string, unknown>) => { calls.push(p); return { sid: `SM${String(++n).padStart(32, "0")}`, numSegments: "1", price: null, status: "queued", ...created }; } },
    fetchMessage: async (sid: string) => prices.get(sid) ?? { sid, price: null, priceUnit: "USD", status: "sent" }
  };
  return { client, calls, prices };
}
const sendSms = (app: Awaited<ReturnType<typeof makeApp>>["app"], key: string, message = "Hi Sarah") =>
  app.inject({ method: "POST", url: "/api/outreach/opp_0001/send", payload: { channel: "sms", message, idempotencyKey: key } });

describe("Twilio spend", () => {
  it("counts segments (GSM-7 160/153, UCS-2 70/67) and parses Twilio's negative price strings", () => {
    expect([smsSegments("a".repeat(160)), smsSegments("a".repeat(161)), smsSegments("a".repeat(306)), smsSegments("a".repeat(307))]).toEqual([1, 2, 2, 3]);
    expect([smsSegments("😀".repeat(35)), smsSegments("😀".repeat(36))]).toEqual([1, 2]);
    expect(twilioPriceUsd({ price: "-0.01180", priceUnit: "USD" })).toBe(0.0118);
    expect(twilioPriceUsd({ price: null })).toBeNull();
    expect(twilioPriceUsd({ price: "-0.01", priceUnit: "EUR" })).toBeNull();
  });

  it("records an estimate at send (SID + segments), then the status callback replaces it with the actual price", async () => {
    const t = fakeTwilio();
    const store = new MemoryStore();
    const messenger = new TwilioSmsProvider({ accountSid: "AC1", authToken: TOKEN, fromNumber: "+15550001111", statusCallbackUrl: o => `${API}/webhooks/twilio/status/${o}` }, t.client);
    const { app } = await makeApp({ store, messenger, env: { TWILIO_AUTH_TOKEN: TOKEN, PUBLIC_API_URL: API, TWILIO_SMS_PRICE_ESTIMATE: "0.0125" } });
    expect((await sendSms(app, "twcost-key-1")).statusCode).toBe(200);
    expect(t.calls[0].statusCallback).toBe(`${API}/webhooks/twilio/status/${DEMO_ORG_ID}`);
    const [row] = await real(store);
    expect(row).toMatchObject({ provider: "twilio", segments: 1, priceUsd: 0.0125, estimated: true });
    const sid = row.messageSid!;

    const url = `/webhooks/twilio/status/${DEMO_ORG_ID}`;
    const params = { MessageSid: sid, MessageStatus: "delivered", AccountSid: "AC1" };
    const post = (sig: string) => app.inject({ method: "POST", url, payload: new URLSearchParams(params).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig } });
    expect((await post("bad")).statusCode).toBe(403);
    t.prices.set(sid, { sid, price: "-0.01280", priceUnit: "USD", numSegments: "1", status: "delivered" });
    expect((await post(twilioSignature(TOKEN, `${API}${url}`, params))).statusCode).toBe(204);
    expect((await real(store))[0]).toMatchObject({ priceUsd: 0.0128, estimated: false, status: "delivered" });
  });

  it("uses Twilio's price when known at send; the log provider is free", async () => {
    const t = fakeTwilio({ price: "-0.0236", priceUnit: "USD", numSegments: "2" });
    const s1 = new MemoryStore();
    const { app: a1 } = await makeApp({ store: s1, messenger: new TwilioSmsProvider({ accountSid: "AC1", authToken: TOKEN, fromNumber: "+1555" }, t.client) });
    await sendSms(a1, "twcost-key-2");
    expect((await real(s1))[0]).toMatchObject({ segments: 2, priceUsd: 0.0236, estimated: false });
    const s2 = new MemoryStore();
    const { app: a2 } = await makeApp({ store: s2 });
    await sendSms(a2, "twcost-key-3");
    expect((await real(s2))[0]).toMatchObject({ provider: "log", messageSid: null, priceUsd: 0, estimated: false });
  });

  it("reconcile fetches prices for estimated rows (skips fresh ones) and leaves unpriced ones estimated", async () => {
    const store = new MemoryStore();
    for (const sid of ["SMa0000000000", "SMb0000000000", "SMc0000000000"]) await store.recordSmsCost(DEMO_ORG_ID, { provider: "twilio", messageSid: sid, segments: 1, priceUsd: 0.0125, estimated: true });
    const later = new Date(Date.now() + 5 * 60_000);
    const fetched: string[] = [];
    const r = await reconcileSmsCosts(store, async sid => { fetched.push(sid); if (sid.startsWith("SMc")) throw new Error("404"); return { sid, price: sid.startsWith("SMa") ? "-0.0118" : null, priceUnit: "USD" }; }, { now: later });
    expect(r).toEqual({ checked: 3, priced: 1, failed: 1 });
    expect((await reconcileSmsCosts(store, async () => { throw new Error("x"); }, { now: new Date() })).checked).toBe(0); // too fresh
    const rows = await real(store);
    expect(rows.find(x => x.messageSid === "SMa0000000000")).toMatchObject({ priceUsd: 0.0118, estimated: false });
    expect(rows.find(x => x.messageSid === "SMb0000000000")).toMatchObject({ estimated: true });
  });

  it("cost report: per-month Twilio line, combined total, estimates and the optional number fee", () => {
    const row = (o: Partial<SmsCostRow>): SmsCostRow => ({ id: "x", provider: "twilio", messageSid: "SM1", segments: 1, priceUsd: 0.0118, estimated: false, isDemo: false, createdAt: "2026-11-02T12:00:00Z", ...o });
    const r = costReport([], [], new Date("2026-11-07T12:00:00Z"), { smsCosts: [row({}), row({ priceUsd: 0.025, segments: 2, estimated: true }), row({ createdAt: "2026-10-02T12:00:00Z" }),
      row({ provider: "log", priceUsd: 0 }), row({ createdAt: "2025-12-31T12:00:00Z" })], numberMonthlyFeeUsd: 1.15 });
    expect(r.ytd.twilio).toMatchObject({ texts: 3, segments: 4, estimatedTexts: 1, numberFeesUsd: 2.3 });
    expect(r.ytd.twilio.costUsd).toBeCloseTo(0.0118 * 2 + 0.025 + 2.3);
    expect(r.months.map(m => m.month)).toEqual(["2026-11", "2026-10"]);
    expect(r.months[0].twilio.costUsd).toBeCloseTo(0.0368 + 1.15);
    expect(r.months[0].combinedUsd).toBeCloseTo(r.months[0].total.costUsd + r.months[0].twilio.costUsd);
  });

  it("demo data has plausible Twilio costs for SMS sends", () => {
    const d = buildDemoMetrics(new Date(2026, 10, 7, 12));
    expect(d.smsCosts.length).toBe(d.sends.filter(s => s.channel === "sms").length);
    for (const c of d.smsCosts) {
      expect(c.priceUsd / c.segments).toBeGreaterThanOrEqual(0.0118 - 1e-9);
      expect(c.priceUsd / c.segments).toBeLessThanOrEqual(0.0133 + 1e-9);
    }
  });

  it("costs API returns Twilio spend; status callback URL only for a public PUBLIC_API_URL", async () => {
    const { app } = await makeApp();
    const r = (await app.inject({ url: "/api/metrics/costs" })).json();
    expect(r.ytd.twilio.texts).toBeGreaterThan(100);
    expect(r.months[0]).toHaveProperty("combinedUsd");
    const mk = (url: string) => createMessageProvider({ EMAIL_PROVIDER: "log", SMS_PROVIDER: "twilio", SMTP_PORT: 587, SMTP_SECURE: false, TWILIO_ACCOUNT_SID: "AC" + "0".repeat(32), TWILIO_AUTH_TOKEN: TOKEN,
      TWILIO_FROM_NUMBER: "+15550001111", PUBLIC_API_URL: url, TWILIO_STATUS_CALLBACKS: true }) as unknown as { sms: { opts: { statusCallbackUrl?: (o: string) => string } } };
    expect(mk("http://localhost:3000").sms.opts.statusCallbackUrl).toBeUndefined(); // Twilio can't reach localhost; reconcile covers it
    expect(mk(API).sms.opts.statusCallbackUrl!("org1")).toBe(`${API}/webhooks/twilio/status/org1`);
  });
});
