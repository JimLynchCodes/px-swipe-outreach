import { describe, expect, it } from "vitest";
import { purchaseInsights, restockWindow } from "../src/insights.js";
import { recommend } from "../src/recommend.js";
import { checkCopy } from "../src/ai/compliance.js";
import { userPayload, systemPrompt } from "../src/ai/prompt.js";
import { RulesSuggestionProvider } from "../src/providers/ai.js";
import { buildSeedDeals, buildSeedOpportunities } from "../src/store/memory.js";
import type { Customer, Deal } from "../src/types.js";

const NOW = Date.parse("2026-11-07T17:00:00Z");
const DAY = 86_400_000;
const item = (name: string, daysAgo: number, category = "vape", productId = name) => ({ productId, name, category, brand: "Geek Bar", priceCents: 1999, imageUrl: null, purchasedAt: new Date(NOW - daysAgo * DAY).toISOString() });
const customer = (over: Partial<Customer> = {}): Customer => ({
  id: "c1", firstName: "Priya", lastName: "Shah", age: 26, gender: null, location: "", storesShopped: [], phone: "+15550100003", email: null, smsConsent: true, emailConsent: false,
  suppressed: [], lifetimeSpendCents: 10000, lastPurchaseAt: new Date(NOW - 6 * DAY).toISOString(), itemsPurchased: 4, ageVerified: true,
  purchases: [item("Geek Bar Pulse", 6), item("Geek Bar Pulse", 13), item("Geek Bar Pulse", 20), item("Clipper Lighter", 40, "accessories")],
  profile: { favoriteCategories: [], favoriteBrands: [], visitsPerMonth: 4, avgBasketCents: 2400, preferredDay: null, preferredTime: null }, ...over
});
const stamp = { orgId: "o", createdAt: "", updatedAt: "", startsOn: null, endsOn: null, active: true, productIds: [] as string[] };
const deal = (over: Partial<Deal>): Deal => ({ ...stamp, id: "d", schedule: "weekly", days: [0, 1, 2, 3, 4, 5, 6], title: "Vape Week", description: "10% off vapes", discountType: "percent", discountValue: 10, categories: ["vape"], ...over });

describe("purchase insights", () => {
  it("predicts the repurchase cycle for consumables (median gap) and when it's due", () => {
    const h = purchaseInsights(customer(), NOW);
    expect(h.restock).toEqual([expect.objectContaining({ name: "Geek Bar Pulse", cycleDays: 7, dueInDays: 1, timesBought: 3 })]);
    expect(restockWindow(h.restock[0])).toBe(true);
    expect(h).toMatchObject({ orders: 4, recencyDays: 6, topCategories: ["vape", "accessories"], topBrands: ["Geek Bar"] });
    expect(h.ordersPerMonth).toBeGreaterThan(2);
    // Non-consumables and single purchases don't get a cycle; long-overdue restocks drop out of the window.
    expect(purchaseInsights(customer({ purchases: [item("Glass Pipe", 3, "glass"), item("Glass Pipe", 30, "glass")] }), NOW).restock).toEqual([]);
    const overdue = purchaseInsights(customer({ purchases: [item("Pods", 60), item("Pods", 67)] }), NOW).restock[0];
    expect(overdue.dueInDays).toBe(-53);
    expect(restockWindow(overdue)).toBe(false);
  });
});

describe("rules engine with history + rewards", () => {
  it("boosts a deal covering a due restock and explains it; mentions real rewards points", () => {
    const deals = [deal({ id: "vape", categories: ["vape"] }), deal({ id: "acc", title: "Accessory Day", categories: ["accessories"], discountValue: 15 })];
    const plain = recommend(customer(), deals, { now: NOW });
    expect(plain.deal!.id).toBe("vape");
    expect(plain.reasons.join(" | ")).toMatch(/Restock due: buys Geek Bar Pulse about every 7 days \(due in 1 day\)/);
    const member = recommend(customer({ rewards: { member: true, points: 1200, joinedAt: "2026-01-01" } }), deals, { now: NOW });
    expect(member.reasons.join(" | ")).toMatch(/Rewards member with 1,200 points/);
  });
  it("rules copy quotes the real balance when it fits, and the validator accepts only that number", async () => {
    const opp = buildSeedOpportunities().find(o => o.customer.firstName === "Jamal")!;
    expect(opp.customer.rewards).toMatchObject({ member: true, points: 340 });
    const promotions = buildSeedDeals("o", new Date());
    const s = await new RulesSuggestionProvider().suggest({ opportunity: opp, channel: "email", businessName: "Cloud 9", recommendation: recommend(opp.customer, promotions), promotions, maxDiscountPercent: 25 } as any);
    expect(s.message).toContain("340 rewards points");
    const base = { channel: "sms" as const, firstName: "Jamal", promotion: null, offerPercent: null, maxDiscountPercent: 25, smsSignature: "" };
    expect(checkCopy({ smsText: "Hi Jamal! You have 340 points. 21+" }, { ...base, rewardsPoints: 340 }).violations).toEqual([]);
    expect(checkCopy({ smsText: "Hi Jamal! You have 500 points. 21+" }, { ...base, rewardsPoints: 340 }).violations.map(v => v.code)).toEqual(["invented_points"]);
    expect(checkCopy({ smsText: "Hi Jamal! Earn 2x points today. 21+" }, { ...base, rewardsPoints: null }).violations.map(v => v.code)).toEqual(["invented_points"]);
    expect(checkCopy({ smsText: "Hi Jamal! You've got 1,200 reward points. 21+" }, { ...base, rewardsPoints: 1200 }).violations).toEqual([]);
  });
  it("AI prompt carries history, restock and rewards facts, plus the points rule", () => {
    const c = customer({ rewards: { member: true, points: 75, joinedAt: "2026-01-01" } });
    const ctx = { storeName: "Cloud 9", voice: { preset: "friendly", emoji: false, signOff: "", about: "" }, channel: "sms", smsSignature: "", maxDiscountPercent: 25,
      customer: c, segment: "loyal", promotions: [], recommendation: { deal: null, dealDay: null, score: 0, segment: "loyal", reasons: [], sendAt: null }, offer: null, now: new Date(NOW) } as any;
    const p = userPayload(ctx).customer as any;
    expect(p.rewards).toEqual({ member: true, points: 75, member_since: "2026-01-01" });
    expect(p.restock_due).toEqual([{ item: "Geek Bar Pulse", every_days: 7, due_in_days: 1 }]);
    expect(p.top_brands_by_purchases).toEqual(["Geek Bar"]);
    expect(systemPrompt(ctx)).toMatch(/quote their points balance EXACTLY/);
    expect((userPayload({ ...ctx, customer: customer() }).customer as any).rewards).toBeNull();
  });
});
