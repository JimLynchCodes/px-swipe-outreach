/** Prompt + structured-output schema for AI outreach copy (smoke shop). See docs/AI_SUGGESTIONS.md. */
import { z } from "zod";
import { daysSince, discountLabel, SMS_OPT_OUT, WEEKDAYS } from "../domain.js";
import { categoryLabel } from "../recommend.js";
import type { BrandVoice, Customer, Deal, Offer, Recommendation, Segment } from "../types.js";
import { EMAIL_BODY_LIMIT, EMAIL_SUBJECT_LIMIT, SMS_LIMIT } from "./compliance.js";

export const PROMPT_VERSION = "2026-11-07.1";

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
  const shots = (Object.keys(FEW_SHOTS) as Segment[])
    .map(s => `Example (${s}): ${FEW_SHOTS[s].situation}\n→ ${JSON.stringify(FEW_SHOTS[s].output)}`).join("\n");
  return [
    `You write one short marketing message for ${ctx.storeName}, a licensed smoke shop (vape, CBD, glass, papers, cigars, hookah). All recipients are age-verified adults 21+ who opted in.`,
    `Voice: ${VOICE_PRESETS[v.preset]}${v.emoji ? " At most one tasteful emoji (not in the SMS if it would push it past the length limit)." : " No emoji."}${v.signOff ? ` Email sign-off: "${v.signOff}".` : ""}`,
    v.about ? `About the shop (use for color, never invent beyond it): ${v.about}` : "",
    "TASK: pick the single best promotion for this customer from PROMOTIONS (or null if none fits), then write the copy. The engine's suggested pick is a hint, not a rule.",
    "HARD RULES (copy that breaks any of these is rejected):",
    "- Use ONLY the promotions provided, with their exact title and discount. Never invent deals, prices, stock, dates or discounts. If promotion_id is null, only the standing offer (if given) may be mentioned.",
    `- Never exceed ${ctx.maxDiscountPercent}% off.`,
    "- No health or medical claims of any kind (e.g. never say CBD helps anxiety, sleep, pain or stress). No claims that any product is safe, safer or healthier than smoking, or helps quit smoking.",
    "- Nothing that appeals to minors: no youth culture, school, cartoons, toys, candy or dessert-flavor hype.",
    "- No free tobacco/nicotine products, samples or giveaways. No 'get high', 'stoned', 'lit' or intoxication language.",
    "- No pressure or urgency (no 'hurry', 'last chance', 'limited time'). You may state a promotion's real end date.",
    "- Address the customer by FIRST name only. Don't mention segments, scores, analytics or how often they visit.",
    "- Include '21+' once. Do NOT write opt-out text or the store signature (both are appended automatically).",
    `- sms_text: at most ${smsBudget(ctx.smsSignature)} characters, plain GSM characters preferred. email_subject: at most ${EMAIL_SUBJECT_LIMIT} characters. email_body: 2-4 short sentences, under ${EMAIL_BODY_LIMIT} characters, no signature.`,
    `- Fill all fields; the requested channel is ${ctx.channel.toUpperCase()}, so make that one great.`,
    shots
  ].filter(Boolean).join("\n");
}

export function userPayload(ctx: PromptContext) {
  const c = ctx.customer, p = c.profile;
  return {
    customer: {
      first_name: c.firstName, segment: ctx.segment, days_since_last_visit: daysSince(c.lastPurchaseAt, ctx.now.getTime()),
      favorite_categories: p.favoriteCategories.map(categoryLabel), favorite_brands: p.favoriteBrands,
      visits_per_month: p.visitsPerMonth, avg_basket_usd: Math.round(p.avgBasketCents / 100),
      preferred_day: p.preferredDay === null ? null : WEEKDAYS[p.preferredDay], preferred_time: p.preferredTime,
      recent_items: c.purchases.slice(0, 5).map(x => x.name)
    },
    today: ctx.now.toISOString().slice(0, 10),
    promotions: ctx.promotions.map(d => ({
      id: d.id, title: d.title, description: d.description, discount: discountLabel(d),
      when: d.schedule === "range" ? `every day ${d.startsOn} to ${d.endsOn}` : `${d.days.map(x => WEEKDAYS[x]).join(", ")}${d.endsOn ? ` until ${d.endsOn}` : ""}`,
      categories: d.categories.map(categoryLabel)
    })),
    engine_suggestion: ctx.recommendation.deal ? { promotion_id: ctx.recommendation.deal.id, reasons: ctx.recommendation.reasons, send_at: ctx.recommendation.sendAt?.label ?? null } : null,
    standing_offer: ctx.offer ? `${ctx.offer.discountPercent}% off next visit` : null,
    discount_cap_percent: ctx.maxDiscountPercent
  };
}
