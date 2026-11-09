/** Prompt + structured-output schema for AI outreach copy (smoke shop). See docs/AI_SUGGESTIONS.md. */
import { purchaseInsights, restockWindow } from "../insights.js";
import { z } from "zod";
import { daysSince, discountLabel, SMS_OPT_OUT, WEEKDAYS } from "../domain.js";
import { categoryLabel } from "../recommend.js";
import type { BrandVoice, Customer, Deal, Offer, Recommendation, Segment } from "../types.js";
import { EMAIL_BODY_LIMIT, EMAIL_SUBJECT_LIMIT, SMS_LIMIT } from "./compliance.js";

export const PROMPT_VERSION = "2026-11-09.1";

export const VOICE_PRESETS: Record<BrandVoice["preset"], string> = {
  friendly: "Friendly local shop: warm, neighborly, plain words, like a regular's favorite budtender texting a heads-up.",
  chill: "Chill: relaxed and low-key, short sentences, casual but never crude or intoxication-themed.",
  premium: "Premium lounge: polished and understated, craft- and quality-focused, no slang, no exclamation marks."
};

/** Default few-shot examples per segment (SMS text only; signature and opt-out are appended by the app). */
export const FEW_SHOTS: Record<Segment, { situation: string; output: { sms_text: string; email_subject: string; email_body: string } }> = {
  loyal: {
    situation: "Loyal, visits 4x/month, loves cigars (Arturo Fuente), Friday evenings; Cigar Friday 20% off runs Friday.",
    output: { sms_text: "Hi Marcus, Cigar Friday is back: 20% off cigars this Friday. Your Arturo Fuente is in the humidor. 21+ w/ ID.",
      email_subject: "Cigar Friday: 20% off, Marcus", email_body: "Hi Marcus,\n\nCigar Friday is back this week with 20% off all cigars, and your Arturo Fuente is stocked in the humidor.\n\nSee you Friday evening (21+ with ID)." }
  },
  at_risk: {
    situation: "At-risk, used to come 2x/month for glass, 40 days since last visit; Glass Weekend 15% off runs Saturday-Sunday.",
    output: { sms_text: "Hi Dana, it's been a minute! Glass Weekend is on: 15% off glass Sat & Sun. New pieces just landed. 21+ w/ ID.",
      email_subject: "Glass Weekend: 15% off, Dana", email_body: "Hi Dana,\n\nIt's been a little while. This weekend is Glass Weekend: 15% off all glass on Saturday and Sunday, with new pieces on the wall.\n\nHope to see you (21+ with ID)." }
  },
  lapsed: {
    situation: "Lapsed, 120 days, used to buy papers and hookah supplies; no matching weekly deal; standing offer 10% off next visit.",
    output: { sms_text: "Hi Sam, we miss you! Here's 10% off your next visit, papers and hookah gear included. 21+ w/ ID.",
      email_subject: "10% off your next visit, Sam", email_body: "Hi Sam,\n\nWe miss seeing you. Come back for 10% off your next visit, papers and hookah gear included.\n\nShow this email at the counter (21+ with ID)." }
  }
};

export const aiOutputSchema = z.object({
  promotion_id: z.string().nullable(),
  reason: z.string().min(1).max(400),
  send_time: z.string().min(1).max(80),
  sms_text: z.string().max(400),
  email_subject: z.string().max(120),
  email_body: z.string().max(2000),
  confidence: z.number().min(0).max(1)
}).strict();
export type AiOutput = z.infer<typeof aiOutputSchema>;

/** OpenAI structured-outputs JSON schema (strict) matching aiOutputSchema. */
export const AI_JSON_SCHEMA = {
  name: "smoke_shop_outreach", strict: true,
  schema: {
    type: "object", additionalProperties: false,
    properties: {
      promotion_id: { type: ["string", "null"], description: "id of ONE promotion from the list, or null for none" },
      reason: { type: "string", description: "1-2 sentences for staff: why this promotion fits this customer" },
      send_time: { type: "string", description: "when to send, e.g. 'Thursday afternoon'" },
      sms_text: { type: "string" }, email_subject: { type: "string" }, email_body: { type: "string" },
      confidence: { type: "number", description: "0-1, how well the promotion fits" }
    },
    required: ["promotion_id", "reason", "send_time", "sms_text", "email_subject", "email_body", "confidence"]
  }
} as const;

export type PromptContext = {
  storeName: string; voice: BrandVoice; channel: "sms" | "email"; smsSignature: string; maxDiscountPercent: number;
  customer: Customer; segment: Segment; promotions: Deal[]; recommendation: Recommendation; offer: Offer | null; now: Date;
};

/** Characters the model may use for sms_text so the final SMS (signature + opt-out line) stays within 160. */
export const smsBudget = (smsSignature: string) => SMS_LIMIT - (smsSignature.trim() ? smsSignature.trim().length + 1 : 0) - (SMS_OPT_OUT.length + 1);

export function systemPrompt(ctx: PromptContext): string {
  const v = ctx.voice;
  // One few-shot for the customer's segment only (saves tokens vs all three).
  const shot = FEW_SHOTS[ctx.segment];
  return [
    `Write one short outreach message for ${ctx.storeName} (licensed smoke shop). Recipients are opted-in adults 21+.`,
    `Voice: ${VOICE_PRESETS[v.preset]}${v.emoji ? " ≤1 emoji if it fits the SMS budget." : " No emoji."}${v.signOff ? ` Email sign-off: "${v.signOff}".` : ""}`,
    v.about ? `Shop facts (do not invent beyond): ${v.about}` : "",
    "Pick ONE promotion from PROMOTIONS (or null) and write copy. engine_suggestion is a hint.",
    `Rules: only listed promotions/exact discounts; cap ${ctx.maxDiscountPercent}% off; no health/safety/quit-smoking claims; no youth appeal; no free tobacco/nicotine; no intoxication slang; no fake urgency; first name only; quote rewards points only if given exactly; optional light restock nudge; include 21+ once; never write opt-out or signature (appended).`,
    `Limits: sms_text ≤${smsBudget(ctx.smsSignature)} chars (GSM preferred); email_subject ≤${EMAIL_SUBJECT_LIMIT}; email_body ≤${EMAIL_BODY_LIMIT}, 2-4 sentences. Channel=${ctx.channel.toUpperCase()}.`,
    `Example (${ctx.segment}): ${shot.situation} → ${JSON.stringify(shot.output)}`
  ].filter(Boolean).join("\n");
}

/** Real purchase history + rewards facts (all grounded; the validator checks any points the copy quotes). */
function historyPayload(ctx: PromptContext) {
  const c = ctx.customer;
  const h = purchaseInsights(c, ctx.now.getTime());
  return {
    orders_per_month: h.ordersPerMonth || null,
    // Prefer purchase-derived tops over profile favorites when present (smaller + grounded).
    top_cats: h.topCategories.slice(0, 3).map(categoryLabel),
    top_brands: h.topBrands.slice(0, 3),
    restock_due: h.restock.filter(restockWindow).slice(0, 2).map(r => ({ item: r.name, due_in_days: r.dueInDays })),
    rewards: c.rewards?.member ? { points: c.rewards.points } : null
  };
}

export function userPayload(ctx: PromptContext) {
  const c = ctx.customer, p = c.profile;
  const hist = historyPayload(ctx);
  return {
    customer: {
      first_name: c.firstName, segment: ctx.segment, days_since: daysSince(c.lastPurchaseAt, ctx.now.getTime()),
      visits_per_month: p.visitsPerMonth, avg_basket_usd: Math.round(p.avgBasketCents / 100),
      preferred_day: p.preferredDay === null ? null : WEEKDAYS[p.preferredDay], preferred_time: p.preferredTime,
      recent_items: c.purchases.slice(0, 3).map(x => x.name),
      ...hist
    },
    today: ctx.now.toISOString().slice(0, 10),
    promotions: ctx.promotions.map(d => ({
      id: d.id, title: d.title, discount: discountLabel(d),
      when: d.schedule === "range" ? `${d.startsOn}..${d.endsOn}` : `${d.days.map(x => WEEKDAYS[x]).join(",")}${d.endsOn ? ` until ${d.endsOn}` : ""}`,
      cats: d.categories.map(categoryLabel)
    })),
    engine_suggestion: ctx.recommendation.deal ? { promotion_id: ctx.recommendation.deal.id, send_at: ctx.recommendation.sendAt?.label ?? null } : null,
    standing_offer: ctx.offer ? `${ctx.offer.discountPercent}% off next visit` : null,
    discount_cap_percent: ctx.maxDiscountPercent
  };
}
