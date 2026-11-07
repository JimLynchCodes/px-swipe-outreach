import { describe, expect, it } from "vitest";
import { FallbackSuggestionProvider, RulesSuggestionProvider, createSuggestionProvider, type SuggestionInput } from "../src/providers/ai.js";
import { buildSeedDeals, buildSeedOpportunities } from "../src/store/memory.js";
import { discountLabel, humanizeDays, isAgeEligible, isValidPhone, segmentOf, SMS_OPT_OUT, withSmsOptOut } from "../src/domain.js";
import { bestDealDay, dealRunsOn, recommend } from "../src/recommend.js";
import { products, seasonalDeals } from "../src/data/seed.js";
import type { Deal } from "../src/types.js";

const opps = buildSeedOpportunities();
// Weekly deals only: seasonal seed promotions are dated relative to today, which would make these assertions date-dependent.
const deals = buildSeedDeals().filter(d => d.schedule === "weekly");
const catalog = products.map(p => ({ id: p.id, name: p.name, brand: p.brand, category: p.category, priceCents: p.priceCents }));
const byName = (n: string) => opps.find(o => o.customer.firstName === n)!;
const input = (name: string, channel: "sms" | "email" = "sms", extra: Partial<SuggestionInput> = {}): SuggestionInput => {
  const opportunity = byName(name);
  return { opportunity, channel, businessName: "Cloud 9 Smoke Shop", recommendation: recommend(opportunity.customer, deals, { catalog }), ...extra };
};

describe("seed data", () => {
  it("has ~20 adult smoke-shop customers covering every segment", () => {
    expect(opps).toHaveLength(20);
    const segments = new Set(opps.map(o => segmentOf(o.customer)));
    expect(segments).toEqual(new Set(["loyal", "at_risk", "lapsed"]));
    for (const o of opps) {
      if (o.customer.ageVerified) expect(o.customer.age).toBeGreaterThanOrEqual(21);
      expect(o.customer.profile.favoriteCategories.length).toBeGreaterThan(0);
    }
    expect(isAgeEligible(byName("Ryan").customer)).toBe(false);
  });
});

describe("deal recommendation", () => {
  it("matches a cigar regular to Cigar Friday on his usual day", () => {
    const rec = recommend(byName("Jamal").customer, deals, { catalog });
    expect(rec.deal?.title).toBe("Cigar Friday");
    expect(rec.dealDay).toBe(4);
    expect(rec.segment).toBe("loyal");
    expect(rec.reasons.join(" ")).toMatch(/Favorite category: cigars/);
    expect(rec.reasons.join(" ")).toMatch(/Runs Friday, the day they usually shop/);
    expect(rec.sendAt).toMatchObject({ dayOfWeek: 4, time: "morning" });
  });

  it("matches vape and hookah customers to their deals and boosts brand/product matches", () => {
    const priya = recommend(byName("Priya").customer, deals, { catalog });
    expect(priya.deal?.title).toBe("Throwback Thursday");
    expect(priya.reasons.join(" ")).toMatch(/Favorite brand on deal: Geek Bar, Elf Bar/);
    expect(recommend(byName("Zoe").customer, deals, { catalog }).deal?.title).toBe("Hookah Night Saturday");
  });

  it("flags lapsed customers and sends morning shoppers the night before", () => {
    const ben = recommend(byName("Ben").customer, deals, { catalog });
    expect(ben.segment).toBe("lapsed");
    expect(ben.reasons[0]).toMatch(/^Lapsed: no visit in 210 days/);
    const hannah = recommend(byName("Hannah").customer, deals, { catalog });
    expect(hannah.deal?.title).toBe("Mellow Monday");
    expect(hannah.sendAt).toMatchObject({ dayOfWeek: 6, time: "evening" });
  });

  it("ignores disabled promotions, out-of-window dates and deals above the discount cap", () => {
    const glass = deals.find(d => d.title === "Holiday Glass Sale")!;
    expect(glass.active).toBe(false);
    const dana = byName("Dana").customer;
    expect(recommend(dana, [glass], { catalog }).deal).toBeNull();
    const on = { ...glass, active: true };
    expect(recommend(dana, [on], { catalog }).deal?.title).toBe("Holiday Glass Sale");
    expect(recommend(dana, [on], { catalog, maxDiscountPercent: 20 }).deal).toBeNull();
    const expired: Deal = { ...glass, active: true, endsOn: "2000-01-01" };
    expect(dealRunsOn(expired, 0)).toBe(false);
    const cigar = deals.find(d => d.title === "Cigar Friday")!;
    expect(recommend(byName("Jamal").customer, deals.filter(d => d !== cigar), { catalog }).deal).toBeNull();
  });

  it("picks the customer's preferred day when a promotion runs on several days", () => {
    const multi: Deal = { ...deals[1], days: [1, 3, 5], active: true };
    expect(bestDealDay(multi, 3)).toBe(3);
    expect([1, 3, 5]).toContain(bestDealDay(multi, 0));
  });
});

describe("suggestion providers", () => {
  it("uses rules when no API key is configured", () => {
    expect(createSuggestionProvider({ model: "x" }).name).toBe("rules");
  });

  it("writes deal-based copy for every eligible customer with the opt-out line", async () => {
    const rules = new RulesSuggestionProvider();
    for (const o of opps) {
      const s = await rules.suggest(input(o.customer.firstName));
      expect(s.message).toContain(o.customer.firstName);
      expect(s.message.endsWith(SMS_OPT_OUT)).toBe(true);
      expect(s.message).toContain("21+");
      expect(s.reasons.length).toBeGreaterThan(0);
    }
  });

  it("explains the chosen deal and appends signatures for the matching channel", async () => {
    const rules = new RulesSuggestionProvider();
    const sigs = { sms: "-Cloud 9", email: "Cloud 9 Smoke Shop\n123 Main St" };
    const sms = await rules.suggest(input("Jamal", "sms", { signatures: sigs }));
    expect(sms).toMatchObject({ title: "Invite them to Cigar Friday (20% off)", deal: { title: "Cigar Friday", day: 4, discountLabel: "20% off" }, segment: "loyal" });
    expect(sms.message).toMatch(/Friday only: Cigar Friday\..*-Cloud 9\nReply STOP to opt out\.$/s);
    expect(sms.message).not.toContain("123 Main St");
    const email = await rules.suggest(input("Jamal", "email", { signatures: sigs }));
    expect(email.subject).toBe("Cigar Friday this Friday, Jamal");
    expect(email.message).toContain("Cloud 9 Smoke Shop\n123 Main St");
    expect(email.message).not.toContain("-Cloud 9");
    expect(email.message).toMatch(/unsubscribe link/i);
  });

  it("falls back to rules when the primary provider fails", async () => {
    const errors: unknown[] = [];
    const p = new FallbackSuggestionProvider(
      { name: "openai", suggest: async () => { throw new Error("rate limited"); } },
      new RulesSuggestionProvider(), e => errors.push(e));
    const s = await p.suggest(input("Sarah"));
    expect(s.source).toBe("rules");
    expect(errors).toHaveLength(1);
  });
});

describe("domain helpers", () => {
  it("humanizes day counts", () => {
    expect(humanizeDays(68)).toBe("over two months");
    expect(humanizeDays(20)).toBe("over two weeks");
  });
  it("validates phone numbers", () => {
    expect(isValidPhone("+1 (555) 555-0123")).toBe(true);
    expect(isValidPhone("123")).toBe(false);
  });
  it("labels discounts and adds the SMS opt-out only once", () => {
    expect(discountLabel({ discountType: "amount", discountValue: 1500 })).toBe("$15 off");
    expect(discountLabel({ discountType: "bogo", discountValue: null })).toBe("Buy one, get one");
    expect(withSmsOptOut("Hi")).toBe(`Hi\n${SMS_OPT_OUT}`);
    expect(withSmsOptOut(`Hi\n${SMS_OPT_OUT}`)).toBe(`Hi\n${SMS_OPT_OUT}`);
  });
});

describe("seasonal (date-range) promotions", () => {
  const NOW = new Date(2026, 10, 25, 10).getTime(); // Wed Nov 25 2026
  const seasonal = (over: Partial<Deal> = {}): Deal => ({
    id: "deal_s", orgId: "o", schedule: "range", days: [0, 1, 2, 3, 4, 5, 6], title: "Holiday Season Glass", description: "20% off glass",
    discountType: "percent", discountValue: 20, categories: ["glass"], productIds: [], startsOn: "2026-11-20", endsOn: "2026-12-31",
    active: true, createdAt: "", updatedAt: "", ...over
  });
  const glassFan = () => opps.find(o => o.customer.profile.favoriteCategories.includes("glass"))!.customer;

  it("runs every day inside its window and never outside it", () => {
    for (let d = 0; d < 7; d++) expect(dealRunsOn(seasonal(), d, NOW)).toBe(true);
    expect(dealRunsOn(seasonal({ startsOn: "2026-12-10" }), 0, NOW)).toBe(false);
    expect(dealRunsOn(seasonal({ endsOn: "2026-11-24" }), 3, NOW)).toBe(false);
    expect(dealRunsOn(seasonal({ active: false }), 3, NOW)).toBe(false);
  });

  it("is considered alongside weekly deals and explains itself", () => {
    const rec = recommend(glassFan(), [seasonal()], { catalog, now: NOW });
    expect(rec.deal?.title).toBe("Holiday Season Glass");
    expect(rec.reasons.join(" ")).toMatch(/Seasonal promotion, runs every day through 2026-12-31/);
    const ending = recommend(glassFan(), [seasonal({ endsOn: "2026-11-28" })], { catalog, now: NOW });
    expect(ending.reasons.join(" ")).toMatch(/ends in 3 days/);
    expect(recommend(glassFan(), [seasonal({ active: false })], { catalog, now: NOW }).deal).toBeNull();
    expect(recommend(glassFan(), [seasonal({ discountValue: 40 })], { catalog, now: NOW, maxDiscountPercent: 25 }).deal).toBeNull();
  });

  it("seeds holiday season, Black Friday weekend, 4/20 week and a month-long special", () => {
    const s = seasonalDeals(new Date(2026, 10, 7));
    expect(s.every(d => d.schedule === "range" && d.days.length === 7 && d.startsOn && d.endsOn)).toBe(true);
    expect(s.find(d => d.title === "Holiday Season Glass")).toMatchObject({ startsOn: "2026-11-20", endsOn: "2026-12-31", active: true });
    expect(s.find(d => d.title === "Black Friday Weekend")).toMatchObject({ startsOn: "2026-11-27", endsOn: "2026-11-29" });
    expect(s.find(d => d.title === "4/20 Week")).toMatchObject({ startsOn: "2027-04-16", endsOn: "2027-04-22" });
    expect(s.find(d => d.title === "November Vape Special")).toMatchObject({ startsOn: "2026-11-01", endsOn: "2026-11-30" });
  });
});
