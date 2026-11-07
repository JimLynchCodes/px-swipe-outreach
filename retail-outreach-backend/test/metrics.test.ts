import { describe, expect, it } from "vitest";
import { fakeSupabase, makeApp } from "./helpers.js";
import { createSuggestionProvider } from "../src/providers/ai.js";
import { MemoryStore } from "../src/store/memory.js";
import { DEMO_ORG, DEMO_ORG_ID, DEMO_USER_ID } from "../src/data/seed.js";
import { costReport } from "../src/metrics/cost.js";
import { attribute, performanceReport } from "../src/metrics/performance.js";
import { buildDemoMetrics } from "../src/data/demoMetrics.js";
import type { AiUsageRow, PurchaseRow, SendRow } from "../src/metrics/types.js";

const send = (o: Partial<SendRow>): SendRow => ({ id: "s1", deliveryId: null, userId: "u1", userLabel: "maya", customerId: "c1", channel: "sms",
  dealId: null, dealTitle: null, dealCategories: [], dealProductIds: [], model: "gpt-4o-mini", isDemo: false, createdAt: "2026-11-01T15:00:00.000Z", ...o });
const buy = (o: Partial<PurchaseRow>): PurchaseRow => ({ customerId: "c1", purchaseId: "p1", purchasedAt: "2026-11-03T15:00:00.000Z", priceCents: 4000,
  category: "vape", productId: null, isDemo: false, ...o });
const use = (o: Partial<AiUsageRow>): AiUsageRow => ({ id: "a", opportunityId: null, model: "gpt-4o-mini", provider: "openai", inputTokens: 700, outputTokens: 150,
  costUsd: 0.000195, priceVersion: "x", dealId: null, dealTitle: null, ledToSend: true, sentChannel: "sms", isDemo: false, createdAt: "2026-10-05T12:00:00.000Z", ...o });

describe("attribution", () => {
  it("credits a purchase within N days to the latest prior send", () => {
    const a = attribute([send({ id: "old", createdAt: "2026-10-30T00:00:00Z" }), send({ id: "new" })], [buy({})], 7);
    expect([...a.keys()]).toEqual(["new"]);
    expect(a.get("new")!.revenueCents).toBe(4000);
  });
  it("ignores purchases outside the window, before the send, or outside the promo's categories", () => {
    expect(attribute([send({})], [buy({ purchasedAt: "2026-11-09T16:00:00Z" })], 7).size).toBe(0);
    expect(attribute([send({})], [buy({ purchasedAt: "2026-10-31T00:00:00Z" })], 7).size).toBe(0);
    expect(attribute([send({ dealCategories: ["glass"] })], [buy({})], 7).size).toBe(0);
    expect(attribute([send({ dealCategories: ["vape"] })], [buy({})], 7).size).toBe(1);
    expect(attribute([send({})], [buy({ purchasedAt: "2026-11-09T16:00:00Z" })], 14).size).toBe(1);
  });
});

describe("month-over-month growth", () => {
  it("compares month-to-date with the same days of last month, not the whole month", () => {
    const now = new Date(2026, 10, 7, 12); // Nov 7 noon, local
    const sends = [send({ id: "a", createdAt: new Date(2026, 10, 3).toISOString() }), send({ id: "b", customerId: "c2", createdAt: new Date(2026, 9, 4).toISOString() }),
      send({ id: "c", customerId: "c3", createdAt: new Date(2026, 9, 20).toISOString() })];
    const buys = [buy({ purchasedAt: new Date(2026, 10, 4).toISOString() }), buy({ customerId: "c2", purchaseId: "p2", purchasedAt: new Date(2026, 9, 5).toISOString() }),
      buy({ customerId: "c3", purchaseId: "p3", priceCents: 50000, purchasedAt: new Date(2026, 9, 21).toISOString() })];
    const r = performanceReport(sends, buys, { now, viewerId: "u1", canSeeAll: true });
    expect(r.summary).toMatchObject({ thisMonthCents: 4000, lastMonthCents: 54000, lastMonthToDateCents: 4000, monthDay: 7, monthGrowthPct: 0 });
  });
  it("clamps to last month's final day (Mar 31 vs Feb 28) and is null with nothing to compare", () => {
    const r = performanceReport([send({ createdAt: new Date(2026, 1, 28, 9).toISOString() })], [buy({ purchasedAt: new Date(2026, 1, 28, 11).toISOString() })], { now: new Date(2026, 2, 31, 12), viewerId: "u1", canSeeAll: true });
    expect(r.summary.lastMonthToDateCents).toBe(4000);
    expect(performanceReport([], [], { now: new Date(2026, 2, 31), viewerId: "u1", canSeeAll: true }).summary.monthGrowthPct).toBeNull();
  });
  it("demo: compares against a partial last month, not the full month", () => {
    const now = new Date(2026, 10, 7, 12);
    const d = buildDemoMetrics(now);
    const s = performanceReport(d.sends, d.purchases, { now, viewerId: "x", canSeeAll: true }).summary;
    expect(s.lastMonthToDateCents).toBeLessThan(s.lastMonthCents / 2);
    expect(s.monthGrowthPct).toBeCloseTo(((s.thisMonthCents - s.lastMonthToDateCents) / s.lastMonthToDateCents) * 100);
  });
});

describe("performance report", () => {
  const now = new Date("2026-11-07T17:00:00Z");
  it("summarises revenue, promotions and hides others' revenue from staff", () => {
    const sends = [send({ dealId: "d1", dealTitle: "Vape Monday", dealCategories: ["vape"] }), send({ id: "s2", userId: "u2", userLabel: "leo", customerId: "c2" })];
    const r = performanceReport(sends, [buy({})], { now, viewerId: "u2", canSeeAll: false });
    expect(r.summary.thisMonthCents).toBe(4000);
    expect(r.summary.conversionRate).toBe(0.5);
    expect(r.summary.avgOrderCents).toBe(4000);
    expect(r.promotions.find(p => p.title === "Vape Monday")).toMatchObject({ sends: 1, usagePct: 50, conversions: 1, revenueCents: 4000 });
    const rows = r.leaderboard.month.rows;
    expect(rows[0]).toMatchObject({ name: "maya", conversions: 1, revenueCents: null });
    expect(rows.find(x => x.isMe)).toMatchObject({ name: "leo", revenueCents: 0 });
    expect(r.leaderboard.today.rows).toEqual([]);
    expect(performanceReport(sends, [buy({})], { now, viewerId: "u2", canSeeAll: true }).leaderboard.all.rows[0].revenueCents).toBe(4000);
  });
});

describe("cost report", () => {
  it("groups YTD usage per month and model, newest month first, with send counts per model", () => {
    const r = costReport([use({}), use({ createdAt: "2026-11-02T12:00:00Z" }), use({ model: "rules", provider: "rules", inputTokens: 0, outputTokens: 0, costUsd: 0 }),
      use({ createdAt: "2025-12-31T12:00:00Z" })], [send({}), send({ channel: "email", model: "rules", createdAt: "2026-10-03T00:00:00Z" })], new Date("2026-11-07T12:00:00Z"));
    expect(r.months.map(m => m.month)).toEqual(["2026-11", "2026-10"]);
    expect(r.ytd.aiCalls).toBe(3);
    expect(r.ytd.messagesSent).toBe(2);
    expect(r.ytd.costUsd).toBeCloseTo(0.00039, 8);
    const oct = r.months[1];
    expect(oct.models.find(m => m.model === "rules")).toMatchObject({ costUsd: 0, emailSent: 1, aiCalls: 1 });
    expect(oct.total.aiCalls).toBe(2);
  });
  it("demo data is deterministic, labelled and priced", () => {
    const now = new Date("2026-11-07T12:00:00Z");
    const a = buildDemoMetrics(now), b = buildDemoMetrics(now);
    expect(a.sends.length).toBe(b.sends.length);
    expect(a.sends.length).toBeGreaterThan(300);
    expect(a.sends.every(s => s.isDemo && s.userLabel.endsWith("(demo)"))).toBe(true);
    expect(a.usage.filter(u => u.model === "rules").every(u => u.costUsd === 0)).toBe(true);
    expect(a.purchases.length).toBeGreaterThan(30);
  });
});

describe("metrics API (demo mode)", () => {
  const app = async () => (await makeApp()).app;
  it("records a suggestion call and its send, and serves cost + performance reports", async () => {
    const a = await app();
    const before = (await a.inject({ url: "/api/metrics/costs" })).json();
    const sug = await a.inject({ method: "POST", url: "/api/outreach/opp_0001/suggestion", payload: { channel: "sms" } });
    expect(sug.statusCode).toBe(200);
    expect(sug.json().suggestion.usage).toBeUndefined();
    const after = (await a.inject({ url: "/api/metrics/costs" })).json();
    expect(after.ytd.aiCalls).toBe(before.ytd.aiCalls + 1);
    expect(after.demo).toBe(true);
    const perf = await a.inject({ url: "/api/metrics/performance?days=10" });
    expect(perf.statusCode).toBe(200);
    expect(perf.json().attributionDays).toBe(10);
    expect(perf.json().leaderboard.all.rows.length).toBeGreaterThanOrEqual(4);
    expect((await a.inject({ url: "/api/metrics/performance?days=0" })).statusCode).toBe(400);
  });

  it("records tokens wasted by a rejected AI attempt (rules fallback) and the main call as free", async () => {
    const bad = JSON.stringify({ promotion_id: null, reason: "x", send_time: "now", sms_text: "Hurry, get high!", email_subject: "x", email_body: "x", confidence: 0.1 });
    const client = { create: async () => ({ choices: [{ message: { content: bad } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } }) };
    const store = new MemoryStore();
    const { app: a } = await makeApp({ store, suggestions: createSuggestionProvider({ apiKey: "k", openai: { client } }) });
    const sug = await a.inject({ method: "POST", url: "/api/outreach/opp_0001/suggestion", payload: { channel: "sms" } });
    expect(sug.json().suggestion).toMatchObject({ source: "rules", model: "rules" });
    expect(sug.json().suggestion.aiAttempt).toBeUndefined();
    const rows = (await store.listAiUsage({ orgId: DEMO_ORG_ID, userId: DEMO_USER_ID } as never, "2000-01-01")).filter(r => !r.isDemo);
    expect(rows.map(r => [r.model, r.inputTokens, r.outputTokens, r.costUsd > 0])).toEqual([["gpt-4o-mini", 2000, 200, true], ["rules", 0, 0, false]]);
  });

  it("a send lands in the ledger with its model and deal; costs are owner/admin only, performance is for everyone", async () => {
    const store = new MemoryStore();
    const fake = await fakeSupabase();
    const OWNER = "11111111-1111-4111-8111-111111111111", STAFF = "33333333-3333-4333-8333-333333333333";
    for (const [u, role] of [[OWNER, "owner"], [STAFF, "staff"]] as const)
      store.addMembership(u, { orgId: DEMO_ORG_ID, orgName: DEMO_ORG.name, businessName: DEMO_ORG.businessName, role });
    const { app } = await makeApp({ store, authenticator: fake.authenticator });
    const as = async (u: string) => ({ authorization: `Bearer ${await fake.sign(u)}`, "x-org-id": DEMO_ORG_ID });
    const sug = (await app.inject({ method: "POST", url: "/api/outreach/opp_0001/suggestion", payload: { channel: "sms" }, headers: await as(STAFF) })).json().suggestion;
    const r = await app.inject({ method: "POST", url: "/api/outreach/opp_0001/send", headers: await as(STAFF),
      payload: { channel: "sms", message: sug.message, idempotencyKey: "metrics-key-1" } });
    expect(r.statusCode).toBe(200);
    const today = (await app.inject({ url: "/api/metrics/performance", headers: await as(STAFF) })).json();
    const me = today.leaderboard.today.rows.find((x: any) => x.isMe);
    expect(me).toMatchObject({ sends: 1, revenueCents: 0 });
    expect(today.revenueVisible).toBe(false);
    expect(today.leaderboard.all.rows.filter((x: any) => !x.isMe).every((x: any) => x.revenueCents === null)).toBe(true);
    expect((await app.inject({ url: "/api/metrics/costs", headers: await as(STAFF) })).statusCode).toBe(403);
    const sends = await store.listSends({ userId: STAFF, orgId: DEMO_ORG_ID }, "2000-01-01");
    expect(sends.at(-1)).toMatchObject({ model: sug.model, dealTitle: sug.deal?.title ?? null, isDemo: false });
    const usage = await store.listAiUsage({ userId: OWNER, orgId: DEMO_ORG_ID }, "2000-01-01");
    expect(usage.at(-1)).toMatchObject({ opportunityId: "opp_0001", ledToSend: true, sentChannel: "sms" });
    // No OPENAI_API_KEY in tests → the "None" (rules) model ran: recorded as a free call.
    expect(usage.at(-1)).toMatchObject({ model: "rules", provider: "rules", inputTokens: 0, outputTokens: 0, costUsd: 0 });
    const costs = (await app.inject({ url: "/api/metrics/costs", headers: await as(OWNER) })).json();
    expect(costs.ytd.byModel.find((m: { model: string }) => m.model === "rules")).toMatchObject({ label: "None", costUsd: 0 });
  });
});
