/** Eval fixtures: the seeded smoke-shop customers × a fixed promotion set (deterministic: no date-relative promos). */
import { buildSeedDeals, buildSeedOpportunities } from "../../store/memory.js";
import { recommend } from "../../recommend.js";
import type { BrandVoice, Channel, Deal } from "../../types.js";
import type { SuggestionInput } from "../../providers/ai.js";

/** Seed customers are dated relative to now, so evals run at "now"; every eval promotion is weekly or spans to 2099. */
export const EVAL_NOW = new Date();
export const EVAL_CAP = 25;
export const EVAL_SIGNATURE = "-Cloud 9";
export const EVAL_VOICE: BrandVoice = { preset: "friendly", emoji: false, signOff: "See you soon!", about: "Family-owned smoke shop on Main St since 2014." };

const stamp = { orgId: "eval", createdAt: EVAL_NOW.toISOString(), updatedAt: EVAL_NOW.toISOString() };
export function evalPromotions(): Deal[] {
  return [
    ...buildSeedDeals("eval", EVAL_NOW).filter(d => d.schedule === "weekly"), // includes an inactive one (Holiday Glass Sale)
    { ...stamp, id: "promo_winter", schedule: "range", days: [0, 1, 2, 3, 4, 5, 6], title: "Winter Warm-Up", description: "20% off cigars and hookah all winter.",
      discountType: "percent", discountValue: 20, categories: ["cigars", "hookah"], productIds: [], startsOn: "2026-01-01", endsOn: "2099-03-20", active: true },
    { ...stamp, id: "promo_overcap", schedule: "range", days: [0, 1, 2, 3, 4, 5, 6], title: "Mega Glass Blowout", description: "40% off all glass.",
      discountType: "percent", discountValue: 40, categories: ["glass"], productIds: [], startsOn: "2026-01-01", endsOn: "2099-12-31", active: true }
  ];
}

export type EvalCase = { id: string; channel: Channel; input: SuggestionInput };

const EMAIL_CASES = ["Sarah", "Marcus", "Elena", "Dana", "Chloe"];

export function evalCases(): EvalCase[] {
  const promotions = evalPromotions();
  const opps = buildSeedOpportunities().filter(o => o.customer.ageVerified);
  const out: EvalCase[] = [];
  const make = (o: (typeof opps)[number], channel: Channel): EvalCase => {
    const offer = o.offer && { ...o.offer, discountPercent: Math.min(o.offer.discountPercent, EVAL_CAP) };
    return {
      id: `${o.customer.firstName.toLowerCase()}-${channel}`, channel,
      input: {
        opportunity: { ...o, offer }, channel, businessName: "Cloud 9 Smoke Shop",
        recommendation: recommend(o.customer, promotions, { maxDiscountPercent: EVAL_CAP }),
        signatures: { sms: EVAL_SIGNATURE, email: "Cloud 9 Smoke Shop" }, model: "gpt-4o-mini",
        promotions, maxDiscountPercent: EVAL_CAP, voice: EVAL_VOICE, now: EVAL_NOW
      }
    };
  };
  for (const o of opps) if (o.customer.phone) out.push(make(o, "sms"));
  for (const o of opps) if (EMAIL_CASES.includes(o.customer.firstName) && o.customer.email) out.push(make(o, "email"));
  return out;
}
