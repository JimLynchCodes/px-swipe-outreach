/**
 * Deal-aware targeting: picks the weekly deal most likely to bring a customer in (and lift their basket),
 * plus when to send it. Pure and deterministic, so it is shared by the rules and LLM suggestion paths.
 */
import { daysSince, discountLabel, segmentOf, weekdayOf, WEEKDAYS } from "./domain.js";
import type { CatalogProduct, Customer, Deal, PreferredTime, Recommendation, Segment } from "./types.js";

const DAY_MS = 86_400_000;
const MIN_SCORE = 25;
const isoDate = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const CATEGORY_LABEL: Record<string, string> = { cbd: "CBD", vape: "vape", glass: "glass", papers: "papers & cones", cigars: "cigars", hookah: "hookah", accessories: "accessories" };
export const categoryLabel = (c: string) => CATEGORY_LABEL[c] ?? c;

/** Days from `now` until the next occurrence of `day` (0 = today). */
export function daysUntil(day: number, now = Date.now()): number {
  return (day - weekdayOf(new Date(now)) + 7) % 7;
}

/** Is the (enabled) promotion running on the next occurrence of `day`? */
export function dealRunsOn(deal: Deal, day: number, now = Date.now()): boolean {
  if (!deal.active || !deal.days.includes(day)) return false;
  const date = isoDate(now + daysUntil(day, now) * DAY_MS);
  return (!deal.startsOn || deal.startsOn <= date) && (!deal.endsOn || deal.endsOn >= date);
}

/** Best day to use a deal for this customer: their usual day if it runs then, else the soonest running day. */
export function bestDealDay(deal: Deal, preferredDay: number | null, now = Date.now()): number | null {
  if (preferredDay !== null && dealRunsOn(deal, preferredDay, now)) return preferredDay;
  const running = deal.days.filter(d => dealRunsOn(deal, d, now)).sort((a, b) => daysUntil(a, now) - daysUntil(b, now));
  return running[0] ?? null;
}

function dealValue(deal: Deal): number {
  switch (deal.discountType) {
    case "percent": return Math.min(15, (deal.discountValue ?? 0) / 2);
    case "amount": return Math.min(15, (deal.discountValue ?? 0) / 100);
    case "bogo": return 10;
    case "freebie": return 6;
  }
}

const SEGMENT_VALUE_WEIGHT: Record<Segment, number> = { lapsed: 1.6, at_risk: 1.2, loyal: 0.6 };

export function sendTiming(dayOfWeek: number, preferred: PreferredTime | null): NonNullable<Recommendation["sendAt"]> {
  // Reach them a few hours before they usually shop: morning shoppers get it the evening before.
  if (preferred === "morning") {
    const day = (dayOfWeek + 6) % 7;
    return { dayOfWeek: day, time: "evening", label: `${WEEKDAYS[day]} evening (night before)` };
  }
  return { dayOfWeek, time: "morning", label: `${WEEKDAYS[dayOfWeek]} morning` };
}

function segmentReason(c: Customer, segment: Segment, now: number): string {
  const days = daysSince(c.lastPurchaseAt, now);
  const every = Math.round(30 / Math.max(0.1, c.profile.visitsPerMonth));
  if (segment === "lapsed") return `Lapsed: no visit in ${days ?? "many"} days (usually every ~${every}) — lead with a strong offer to win them back`;
  if (segment === "at_risk") return `At risk: ${days} days since last visit vs. usual ~${every} — nudge before they drift to another shop`;
  return `Loyal regular (~${c.profile.visitsPerMonth}×/month) — reward them without deep discounting`;
}

export type RecommendOptions = { catalog?: CatalogProduct[]; maxDiscountPercent?: number; now?: number };

export function recommend(c: Customer, deals: Deal[], opts: RecommendOptions = {}): Recommendation {
  const { catalog = [], maxDiscountPercent = 100, now = Date.now() } = opts;
  const segment = segmentOf(c, now);
  const brandOf = new Map(catalog.map(p => [p.id, p.brand]));
  const favCats = new Set(c.profile.favoriteCategories);
  const favBrands = new Set(c.profile.favoriteBrands.map(b => b.toLowerCase()));
  const recent = c.purchases.filter(p => (daysSince(p.purchasedAt, now) ?? 999) <= 120);
  const recentCats = new Set(recent.map(p => p.category).filter(Boolean) as string[]);
  const boughtIds = new Set(c.purchases.map(p => p.productId));
  const basketBoost = Math.min(10, c.profile.avgBasketCents / 1000);

  let best: { deal: Deal; day: number; score: number; reasons: string[] } | null = null;
  for (const deal of deals) {
    if (deal.discountType === "percent" && (deal.discountValue ?? 0) > maxDiscountPercent) continue;
    const day = bestDealDay(deal, c.profile.preferredDay, now);
    if (day === null) continue;
    const reasons: string[] = [];
    let score = 0;
    const catHits = deal.categories.filter(x => favCats.has(x));
    const recentHits = deal.categories.filter(x => recentCats.has(x) && !favCats.has(x));
    const productHits = deal.productIds.filter(id => boughtIds.has(id));
    const brandHits = [...new Set(deal.productIds.map(id => brandOf.get(id)).filter((b): b is string => !!b && favBrands.has(b.toLowerCase())))];
    const storewide = deal.categories.length === 0 && deal.productIds.length === 0;
    if (!catHits.length && !recentHits.length && !productHits.length && !brandHits.length && !storewide) continue;

    if (catHits.length) { score += 30 + 10 * (catHits.length - 1) + basketBoost; reasons.push(`Favorite category: ${catHits.map(categoryLabel).join(", ")}`); }
    if (recentHits.length) { score += 10; reasons.push(`Recently bought ${recentHits.map(categoryLabel).join(", ")}`); }
    if (productHits.length) {
      score += 20;
      const names = c.purchases.filter(p => productHits.includes(p.productId)).map(p => p.name);
      reasons.push(`Deal covers something they buy: ${[...new Set(names)].slice(0, 2).join(", ")}`);
    }
    if (brandHits.length) { score += 15; reasons.push(`Favorite brand on deal: ${brandHits.join(", ")}`); }
    if (storewide) { score += 8; reasons.push("Storewide deal"); }
    if (deal.schedule === "range" && deal.endsOn) {
      const left = Math.round((Date.parse(`${deal.endsOn}T00:00:00`) - Date.parse(`${isoDate(now)}T00:00:00`)) / DAY_MS);
      reasons.push(`Seasonal promotion, runs every day through ${deal.endsOn}${left >= 0 && left <= 7 ? ` (ends in ${left} day${left === 1 ? "" : "s"})` : ""}`);
      if (left >= 0 && left <= 7) score += 5;
    }
    if (c.profile.preferredDay === day) {
      score += 20;
      reasons.push(`Runs ${WEEKDAYS[day]}, the day they usually shop${c.profile.preferredTime ? ` (${c.profile.preferredTime})` : ""}`);
    } else if (daysUntil(day, now) <= 2) {
      score += 5;
      reasons.push(`Runs soon (${WEEKDAYS[day]})`);
    }
    score += dealValue(deal) * SEGMENT_VALUE_WEIGHT[segment];
    if (!best || score > best.score) best = { deal, day, score, reasons };
  }

  if (best && best.score >= MIN_SCORE) {
    return {
      deal: best.deal, dealDay: best.day, score: Math.round(best.score), segment,
      reasons: [segmentReason(c, segment, now), ...best.reasons, `Uses deal: ${best.deal.title} (${discountLabel(best.deal)})`],
      sendAt: sendTiming(best.day, c.profile.preferredTime)
    };
  }
  return {
    deal: null, dealDay: null, score: 0, segment,
    reasons: [segmentReason(c, segment, now), "No current deal matches their favorites, so the standing offer is used"],
    sendAt: c.profile.preferredDay === null ? null : sendTiming(c.profile.preferredDay, c.profile.preferredTime)
  };
}

export const describeSegment = (s: Segment) => cap(s.replace("_", "-"));
