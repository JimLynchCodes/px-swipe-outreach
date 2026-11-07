/**
 * Compliance guardrails for tobacco / vape / CBD / hemp marketing copy. Enforced twice: stated in the prompt, and checked
 * here after generation (a violation triggers one regeneration, then a fall back to rules).
 * These are reasonable defaults, NOT legal advice: rules vary by state and channel. Have counsel review your program.
 */
import { discountLabel, SMS_OPT_OUT } from "../domain.js";
import type { DealInput } from "../types.js";

export const SMS_LIMIT = 160;
export const EMAIL_SUBJECT_LIMIT = 50;
export const EMAIL_BODY_LIMIT = 700;

export type Violation = { code: string; message: string };

/** Each rule: a code, a human message (also fed back to the model on retry), and patterns that trip it. */
export const BANNED: Array<{ code: string; message: string; patterns: RegExp[] }> = [
  { code: "health_claim", message: "No health or medical claims (e.g. that CBD helps anxiety, sleep or pain).",
    patterns: [
      /\b(help|helps|helping|cure|cures|treat|treats|relieve|relieves|relief|ease|eases|heal|heals|soothe|soothes|calm|calms|reduce|reduces|fight|fights)\b[^.!?\n]{0,40}\b(anxiety|stress|pain|sleep|insomnia|depression|inflammation|nausea|seizures?|ptsd|aches?|headaches?|mood)\b/i,
      /\b(medical|medicinal|therapeutic|clinically|doctor[- ]recommended|health benefits?|wellness benefits?|anti[- ]inflammatory|immune)\b/i
    ] },
  { code: "safety_claim", message: "No claims that vaping/CBD/any product is safe or safer/healthier than smoking, or helps quit.",
    patterns: [/\b(safer|healthier|less harmful|harmless|risk[- ]free|safe alternative)\b/i, /\b(quit|quitting|stop) smoking\b/i, /\bsmoking cessation\b/i] },
  { code: "youth_appeal", message: "Nothing that appeals to minors: no youth culture, school, cartoons, toys or candy language.",
    patterns: [/\b(kids?|teens?|teenagers?|students?|school|homework|prom|cartoons?|unicorns?|toys?|candy|candies|lollipop|gummy bears?|cereal|bubble ?gum|anime|fortnite|tiktok)\b/i] },
  { code: "free_tobacco", message: "No free tobacco/nicotine products or giveaways (discounts on purchases are fine).",
    patterns: [/\bfree\b[^.!?\n]{0,25}\b(vapes?|pods?|e-?liquids?|e-?juices?|juice|cigars?|cigarettes?|cigarillos?|nicotine|tobacco|disposables?|hookah|shisha|samples?)\b/i,
      /\b(giveaway|give-away|giving away)\b/i] },
  { code: "intoxication", message: "No 'get high'/intoxication language.",
    patterns: [/\b(get(ting)?|gets) (high|lit|baked|stoned|blazed|faded|zooted)\b/i, /\b(stoned|blazed|zooted|wasted|buzzed|high af)\b/i] },
  { code: "fake_urgency", message: "No pressure or urgency beyond the promotion's real end date.",
    patterns: [/\b(last chance|hurry|act now|don'?t miss out|before it'?s gone|while supplies last|only \d+ left|selling fast|ends (today|tonight)|final hours?|limited time)\b/i] }
];

export type PromoTerms = Pick<DealInput, "title" | "discountType" | "discountValue" | "endsOn"> & { id: string };

export type CopyCheckContext = {
  channel: "sms" | "email";
  /** The customer's real rewards balance (null/undefined = not a member: no points may be quoted). */
  rewardsPoints?: number | null;
  firstName: string;
  lastName?: string | null;
  /** Promotion the copy claims to use (already resolved from the model's promotion_id), or null. */
  promotion: PromoTerms | null;
  /** Fallback offer percent when no promotion (already capped), or null. */
  offerPercent: number | null;
  maxDiscountPercent: number;
  smsSignature: string;
  /** "now" for the urgency rule (a promo ending within 2 days may say "ends Sunday"). */
  now?: Date;
};

/** Final SMS exactly as it will be sent (text + signature + opt-out line). */
export const assembleSms = (text: string, signature: string) =>
  `${text.trim()}${signature.trim() ? ` ${signature.trim()}` : ""}\n${SMS_OPT_OUT}`;

/** Characters outside the GSM-7 alphabet force UCS-2 (70-char segments). Reported as a warning, not a failure. */
const GSM7 = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/;
export const isGsm7 = (s: string) => GSM7.test(s);

/** Every "N% off" / "$N off" in the copy must be the promotion's (or offer's) real terms and within the cap. */
function checkDiscounts(text: string, ctx: CopyCheckContext): Violation[] {
  const out: Violation[] = [];
  const allowedPct = ctx.promotion?.discountType === "percent" ? ctx.promotion.discountValue : ctx.promotion ? null : ctx.offerPercent;
  const allowedAmt = ctx.promotion?.discountType === "amount" ? ctx.promotion.discountValue : null;
  for (const m of text.matchAll(/(\d{1,3})\s?%/g)) {
    const pct = Number(m[1]);
    if (pct > ctx.maxDiscountPercent) out.push({ code: "over_cap", message: `${pct}% is above the store's ${ctx.maxDiscountPercent}% discount cap.` });
    else if (pct !== allowedPct) out.push({ code: "invented_discount", message: `"${m[0]}" doesn't match the real promotion terms${allowedPct != null ? ` (${allowedPct}%)` : ""}.` });
  }
  for (const m of text.matchAll(/\$(\d+(?:\.\d{2})?)\s?off/gi)) {
    const cents = Math.round(Number(m[1]) * 100);
    if (cents !== allowedAmt) out.push({ code: "invented_discount", message: `"${m[0]}" doesn't match the real promotion terms.` });
  }
  if (/\b(bogo|buy one,? get one|2 for 1|two for one)\b/i.test(text) && ctx.promotion?.discountType !== "bogo") {
    out.push({ code: "invented_discount", message: "Mentions a BOGO deal that isn't the promotion's terms." });
  }
  return out;
}

export function checkCopy(copy: { smsText?: string; emailSubject?: string; emailBody?: string }, ctx: CopyCheckContext): { violations: Violation[]; warnings: string[] } {
  const violations: Violation[] = [];
  const warnings: string[] = [];
  const parts = ctx.channel === "sms" ? [copy.smsText ?? ""] : [copy.emailSubject ?? "", copy.emailBody ?? ""];
  const all = parts.join("\n");
  if (!all.trim()) violations.push({ code: "empty", message: "The message is empty." });
  for (const rule of BANNED) {
    if (rule.code === "fake_urgency" && ctx.promotion?.endsOn && ctx.now) {
      const daysLeft = (Date.parse(`${ctx.promotion.endsOn}T23:59:59`) - ctx.now.getTime()) / 86_400_000;
      if (daysLeft >= 0 && daysLeft <= 2) continue; // a real end date this close may be mentioned
    }
    if (rule.patterns.some(p => p.test(all))) violations.push({ code: rule.code, message: rule.message });
  }
  violations.push(...checkDiscounts(all, ctx));
  for (const m of all.matchAll(/(\d[\d,]*)\s*x?\s*(?:reward\s*)?(?:points?|pts)\b/gi)) {
    const n = Number(m[1].replace(/,/g, ""));
    if (ctx.rewardsPoints == null || n !== ctx.rewardsPoints) {
      violations.push({ code: "invented_points", message: ctx.rewardsPoints == null ? "The customer isn't a rewards member; don't mention points." : `"${m[0]}" doesn't match their real balance (${ctx.rewardsPoints} points).` });
    }
  }
  if (ctx.promotion && !new RegExp(escape(ctx.promotion.title), "i").test(all) && !all.toLowerCase().includes(discountLabel(ctx.promotion).toLowerCase())) {
    violations.push({ code: "ungrounded", message: `Name the promotion ("${ctx.promotion.title}") or its exact terms (${discountLabel(ctx.promotion)}).` });
  }
  if (!new RegExp(`\\b${escape(ctx.firstName)}\\b`, "i").test(all)) violations.push({ code: "no_name", message: `Greet the customer by first name (${ctx.firstName}).` });
  if (ctx.lastName && new RegExp(`\\b${escape(ctx.lastName)}\\b`, "i").test(all)) violations.push({ code: "last_name", message: "Use the first name only." });
  if (/\b(reply stop|opt out|unsubscribe)\b/i.test(all)) violations.push({ code: "self_opt_out", message: "Don't write opt-out text; it is appended automatically." });
  if (ctx.channel === "sms") {
    const final = assembleSms(copy.smsText ?? "", ctx.smsSignature);
    if (final.length > SMS_LIMIT) violations.push({ code: "sms_too_long", message: `SMS is ${final.length} chars with signature and opt-out line; the limit is ${SMS_LIMIT}.` });
    if (!isGsm7(final)) warnings.push("non-GSM-7 characters (e.g. emoji) make this a UCS-2 message (70 chars per segment)");
  } else {
    if ((copy.emailSubject ?? "").length > EMAIL_SUBJECT_LIMIT) violations.push({ code: "subject_too_long", message: `Subject is over ${EMAIL_SUBJECT_LIMIT} characters.` });
    if (!(copy.emailSubject ?? "").trim()) violations.push({ code: "no_subject", message: "Email needs a subject." });
    if ((copy.emailBody ?? "").length > EMAIL_BODY_LIMIT) violations.push({ code: "body_too_long", message: `Email body is over ${EMAIL_BODY_LIMIT} characters; keep it short.` });
  }
  return { violations, warnings };
}

function escape(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
