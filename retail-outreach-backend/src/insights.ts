/**
 * Purchase-history insights for the suggestion engine (rules + AI prompt): frequency, recency, AOV, typical day/time,
 * favorite categories/brands (from real items), and repurchase-cycle predictions for consumables. Works on the
 * customer's itemized purchases (Quickvee orders land there via data sync) plus the stored profile.
 */
import type { Customer, PurchasedItem } from "./types.js";

const DAY = 86_400_000;
/** Categories people restock on a cycle. */
export const CONSUMABLE_CATEGORIES = new Set(["vape", "cbd", "papers", "cigars", "hookah", "e-liquid", "pods", "tobacco", "accessories-consumable"]);
const CONSUMABLE_NAME = /\b(pod|pods|coil|coils|e-?liquid|juice|papers?|cones?|wraps?|coals?|shisha|disposable|refill|tobacco|cigars?)\b/i;

export type Restock = { name: string; category: string | null; productId: string; cycleDays: number; lastAt: string; dueInDays: number; timesBought: number };
export type Insights = {
  orders: number; recencyDays: number | null; ordersPerMonth: number; aovCents: number | null;
  topCategories: string[]; topBrands: string[]; restock: Restock[];
};

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const top = (xs: Array<string | null>, n = 3) => {
  const c = new Map<string, number>();
  for (const x of xs) if (x) c.set(x, (c.get(x) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([k]) => k);
};
const isConsumable = (i: PurchasedItem) => (i.category && CONSUMABLE_CATEGORIES.has(i.category)) || CONSUMABLE_NAME.test(i.name);

export function purchaseInsights(c: Customer, now = Date.now()): Insights {
  const items = c.purchases;
  // Items bought within the same minute-ish belong to one order.
  const orderDays = [...new Set(items.map(i => Math.floor(Date.parse(i.purchasedAt) / 3_600_000)))];
  const spanDays = orderDays.length ? Math.max(30, (now - Math.min(...orderDays) * 3_600_000) / DAY) : 0;
  const last = c.lastPurchaseAt ?? items[0]?.purchasedAt ?? null;
  const restock: Restock[] = [];
  const byKey = new Map<string, PurchasedItem[]>();
  for (const i of items) if (isConsumable(i)) { const k = i.productId || i.name.toLowerCase(); byKey.set(k, [...(byKey.get(k) ?? []), i]); }
  for (const list of byKey.values()) {
    const days = [...new Set(list.map(i => Math.floor(Date.parse(i.purchasedAt) / DAY)))].sort((a, b) => a - b);
    if (days.length < 2) continue;
    const gaps = days.slice(1).map((d, k) => d - days[k]).filter(g => g >= 2);
    if (!gaps.length) continue;
    const cycle = Math.round(median(gaps));
    const lastDay = days[days.length - 1];
    const due = lastDay + cycle - Math.floor(now / DAY);
    restock.push({ name: list[0].name, category: list[0].category, productId: list[0].productId, cycleDays: cycle, lastAt: new Date(lastDay * DAY).toISOString(), dueInDays: due, timesBought: days.length });
  }
  restock.sort((a, b) => a.dueInDays - b.dueInDays);
  return {
    orders: orderDays.length, recencyDays: last ? Math.floor((now - Date.parse(last)) / DAY) : null,
    ordersPerMonth: orderDays.length ? Math.round((orderDays.length / spanDays) * 30 * 10) / 10 : 0,
    aovCents: c.profile.avgBasketCents || null,
    topCategories: top(items.map(i => i.category)), topBrands: top(items.map(i => i.brand)), restock
  };
}

/** A restock is worth acting on from a few days before it's due until one cycle overdue. */
export const restockWindow = (r: Restock) => r.dueInDays <= 5 && r.dueInDays >= -r.cycleDays;
