/** Suggestion-cache fingerprint and public payload helpers. See docs/AI_SUGGESTIONS.md. */
import { createHash } from "node:crypto";
import { eligiblePromotions } from "../providers/ai.js";
import type { BrandVoice, Channel, Deal, OrgSettings, Suggestion } from "../types.js";

/** Bump when the prompt/shape that feeds the model changes (invalidates every cached card). */
export const CACHE_SCHEMA = "2026-11-09.1";

export type SuggestionCacheKeyInput = {
  aiModel: string;
  brandVoice: BrandVoice;
  maxDiscountPercent: number;
  smsSignature: string;
  emailSignature: string;
  storeName: string | null;
  /** Eligible promotions only (ids + discount + schedule). */
  promotions: Deal[];
  channel: Channel;
};

/** Stable fingerprint: same inputs → same key → cache hit (no new AI call). */
export function suggestionCacheKey(input: SuggestionCacheKeyInput, now = Date.now()): string {
  const promos = eligiblePromotions(input.promotions, input.maxDiscountPercent, now)
    .map(d => [d.id, d.title, d.discountType, d.discountValue, d.schedule, d.days.join(""), d.startsOn ?? "", d.endsOn ?? "", d.active ? 1 : 0].join(":"))
    .sort();
  const v = input.brandVoice;
  const raw = JSON.stringify({
    s: CACHE_SCHEMA, m: input.aiModel, ch: input.channel, cap: input.maxDiscountPercent,
    store: input.storeName ?? "", sms: input.smsSignature, email: input.emailSignature,
    voice: { p: v.preset, e: v.emoji, so: v.signOff, a: v.about }, promos
  });
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

/** Strip server-only fields before caching / returning to clients. */
export function publicSuggestion(s: Suggestion): Suggestion {
  const { usage: _u, aiAttempt: _a, ...rest } = s;
  return rest;
}

export function cacheKeyFromSettings(
  settings: OrgSettings, channel: Channel, promotions: Deal[], storeName: string | null
): string {
  return suggestionCacheKey({
    aiModel: settings.aiModel, brandVoice: settings.brandVoice, maxDiscountPercent: settings.maxDiscountPercent,
    smsSignature: settings.smsSignature, emailSignature: settings.emailSignature,
    storeName: settings.storeName ?? storeName, promotions, channel
  });
}
