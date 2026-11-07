import type { PurchaseRow, SendRow } from "./types.js";

export const DEFAULT_ATTRIBUTION_DAYS = 7;
export type Period = "today" | "week" | "month" | "all";
export const PERIODS: Period[] = ["today", "week", "month", "all"];

export type LeaderRow = {
  userKey: string; name: string; isMe: boolean; sends: number; conversions: number; conversionRate: number;
  /** Cents; null when hidden (staff only see their own revenue). */
  revenueCents: number | null; streakDays: number; onFire: boolean;
};
export type PerformanceReport = {
  attributionDays: number; demo: boolean; revenueVisible: boolean;
  summary: {
    thisMonthCents: number; lastMonthCents: number; monthGrowthPct: number | null; ytdCents: number;
    ytdSends: number; ytdConversions: number; conversionRate: number; avgOrderCents: number;
  };
  trend: Array<{ month: string; revenueCents: number; sends: number; conversions: number }>;
  promotions: Array<{ dealId: string | null; title: string; sends: number; usagePct: number; conversions: number; conversionRate: number; revenueCents: number }>;
  leaderboard: Record<Period, { rows: LeaderRow[]; totals: Omit<LeaderRow, "userKey" | "name" | "isMe" | "streakDays" | "onFire"> }>;
};

const DAY = 86_400_000;
const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const rate = (c: number, s: number) => (s ? c / s : 0);

/**
 * Attribution: a purchase counts for the most recent send to the same customer made within `days` days before it.
 * If that send featured a promotion with categories/products, only purchase lines in those categories/products count
 * (no promo codes exist in the POS data, so category/product is the match). A send without a promotion counts any line.
 * A send with >=1 attributed line is a conversion; attributed revenue is the sum of those lines.
 */
export function attribute(sends: SendRow[], purchases: PurchaseRow[], days = DEFAULT_ATTRIBUTION_DAYS) {
  const bySend = new Map<string, { revenueCents: number; orders: Set<string> }>();
  const byCustomer = new Map<string, SendRow[]>();
  for (const s of [...sends].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const xs = byCustomer.get(s.customerId) ?? [];
    xs.push(s);
    byCustomer.set(s.customerId, xs);
  }
  for (const p of purchases) {
    const t = Date.parse(p.purchasedAt);
    const candidates = byCustomer.get(p.customerId) ?? [];
    let hit: SendRow | undefined;
    for (let i = candidates.length - 1; i >= 0; i--) {
      const st = Date.parse(candidates[i].createdAt);
      if (st > t) continue;
      if (t - st > days * DAY) break;
      hit = candidates[i];
      break;
    }
    if (!hit) continue;
    const scoped = hit.dealCategories.length > 0 || hit.dealProductIds.length > 0;
    const matches = !scoped || (p.category != null && hit.dealCategories.includes(p.category)) || (p.productId != null && hit.dealProductIds.includes(p.productId));
    if (!matches) continue;
    const a = bySend.get(hit.id) ?? { revenueCents: 0, orders: new Set<string>() };
    a.revenueCents += p.priceCents;
    a.orders.add(p.purchaseId);
    bySend.set(hit.id, a);
  }
  return bySend;
}

export function periodStart(period: Period, now: Date): number {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === "today") return today.getTime();
  if (period === "week") return today.getTime() - ((today.getDay() + 6) % 7) * DAY;
  if (period === "month") return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return 0;
}

export function performanceReport(sends: SendRow[], purchases: PurchaseRow[], opts: { now?: Date; days?: number; viewerId: string; canSeeAll: boolean }): PerformanceReport {
  const now = opts.now ?? new Date();
  const days = opts.days ?? DEFAULT_ATTRIBUTION_DAYS;
  const att = attribute(sends, purchases, days);
  const rev = (s: SendRow) => att.get(s.id)?.revenueCents ?? 0;
  const conv = (s: SendRow) => att.has(s.id);
  const at = (s: SendRow) => Date.parse(s.createdAt);
  const thisMonth = monthKey(now), lastMonth = monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const yearStart = new Date(now.getFullYear(), 0, 1).getTime();

  const months = new Map<string, { revenueCents: number; sends: number; conversions: number }>();
  for (let i = 5; i >= 0; i--) months.set(monthKey(new Date(now.getFullYear(), now.getMonth() - i, 1)), { revenueCents: 0, sends: 0, conversions: 0 });
  let ytdCents = 0, ytdSends = 0, ytdConv = 0, ytdOrders = 0;
  for (const s of sends) {
    const m = months.get(monthKey(new Date(s.createdAt)));
    if (m) { m.sends++; m.revenueCents += rev(s); m.conversions += conv(s) ? 1 : 0; }
    if (at(s) >= yearStart) { ytdSends++; ytdCents += rev(s); if (conv(s)) { ytdConv++; ytdOrders += att.get(s.id)!.orders.size; } }
  }
  const tm = months.get(thisMonth)!.revenueCents, lm = months.get(lastMonth)!.revenueCents;

  const promos = new Map<string, PerformanceReport["promotions"][number]>();
  const ytdList = sends.filter(s => at(s) >= yearStart);
  for (const s of ytdList) {
    const key = s.dealTitle ?? "";
    const p = promos.get(key) ?? { dealId: s.dealId, title: s.dealTitle ?? "No promotion", sends: 0, usagePct: 0, conversions: 0, conversionRate: 0, revenueCents: 0 };
    p.sends++; p.conversions += conv(s) ? 1 : 0; p.revenueCents += rev(s);
    promos.set(key, p);
  }
  const promotions = [...promos.values()].map(p => ({ ...p, usagePct: rate(p.sends, ytdList.length) * 100, conversionRate: rate(p.conversions, p.sends) }))
    .sort((a, b) => b.revenueCents - a.revenueCents || b.sends - a.sends);

  const userKey = (s: SendRow) => s.userId ?? `label:${s.userLabel}`;
  const leaderboard = {} as PerformanceReport["leaderboard"];
  for (const period of PERIODS) {
    const from = periodStart(period, now);
    const rows = new Map<string, LeaderRow & { days: Set<string> }>();
    for (const s of sends) {
      const k = userKey(s);
      const r = rows.get(k) ?? { userKey: k, name: s.userLabel, isMe: s.userId === opts.viewerId, sends: 0, conversions: 0, conversionRate: 0, revenueCents: 0, streakDays: 0, onFire: false, days: new Set<string>() };
      r.days.add(dayKey(new Date(s.createdAt)));
      rows.set(k, r);
      if (at(s) < from || at(s) > now.getTime()) continue;
      r.sends++; r.conversions += conv(s) ? 1 : 0; r.revenueCents! += rev(s);
    }
    const list = [...rows.values()].filter(r => r.sends > 0).map(({ days: ds, ...r }) => {
      // Streak: consecutive days with sends, ending today (or yesterday, so a not-yet-started day doesn't reset it).
      let streak = 0;
      let d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      if (!ds.has(dayKey(d))) d = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
      while (ds.has(dayKey(d))) { streak++; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1); }
      const conversionRate = rate(r.conversions, r.sends);
      return { ...r, conversionRate, streakDays: streak, onFire: r.sends >= 5 && conversionRate >= 0.3,
        revenueCents: opts.canSeeAll || r.isMe ? r.revenueCents : null };
    }).sort((a, b) => b.conversions - a.conversions || b.sends - a.sends || a.name.localeCompare(b.name));
    const t = list.reduce((x, r) => ({ sends: x.sends + r.sends, conversions: x.conversions + r.conversions }), { sends: 0, conversions: 0 });
    const allRev = [...rows.values()].reduce((x, r) => x + (r.revenueCents ?? 0), 0);
    leaderboard[period] = { rows: list, totals: { ...t, conversionRate: rate(t.conversions, t.sends), revenueCents: allRev } };
  }
  return {
    attributionDays: days, demo: sends.some(s => s.isDemo), revenueVisible: opts.canSeeAll,
    summary: { thisMonthCents: tm, lastMonthCents: lm, monthGrowthPct: lm ? ((tm - lm) / lm) * 100 : null, ytdCents,
      ytdSends, ytdConversions: ytdConv, conversionRate: rate(ytdConv, ytdSends), avgOrderCents: ytdOrders ? Math.round(ytdCents / ytdOrders) : 0 },
    trend: [...months.entries()].map(([month, v]) => ({ month, ...v })),
    promotions,
    leaderboard
  };
}
