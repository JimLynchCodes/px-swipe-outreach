/**
 * Clearly-labelled DEMO metrics: AI usage, sends by several (fictional) staff, and purchases, for ~5 months before
 * `now`. Deterministic (seeded PRNG) so tests are stable. Every row has isDemo=true and staff are suffixed "(demo)".
 */
import { costUsd, PRICE_TABLE_VERSION } from "../ai/models.js";
import type { AiUsageRow, PurchaseRow, SendRow, SmsCostRow } from "../metrics/types.js";
import * as seed from "./seed.js";

export const DEMO_STAFF = ["Maya R. (demo)", "Leo T. (demo)", "Ava K. (demo)", "Sam P. (demo)"] as const;
const MODEL_MIX = ["gpt-4o-mini", "gpt-4o-mini", "gpt-4o-mini", "gpt-5-mini", "rules"] as const;
const STAFF_SKILL = [0.36, 0.3, 0.24, 0.18]; // conversion propensity, so the leaderboard has a spread

function rng(seedN: number) {
  let s = seedN >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

export function buildDemoMetrics(now = new Date(), days = 150, idOf: (kind: string, i: number) => string = (k, i) => `${k}_${i}`) {
  const r = rng(42);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const usage: AiUsageRow[] = [];
  const sends: SendRow[] = [];
  const purchases: PurchaseRow[] = [];
  const smsCosts: SmsCostRow[] = [];
  const weekly = seed.deals.filter(d => d.schedule === "weekly" && d.active);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
  const nowMs = now.getTime();
  for (let d = 0; d <= days; d++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + d);
    const weekday = (day.getDay() + 6) % 7;
    const busy = 4 + Math.floor(r() * 8) + Math.floor(d / 30); // gentle growth over time
    for (let k = 0; k < busy; k++) {
      const at = new Date(day.getTime() + (10 + r() * 10) * 3_600_000);
      if (at.getTime() > nowMs) continue;
      const model = pick(MODEL_MIX);
      const provider = model === "rules" ? "rules" : "openai";
      const inT = model === "rules" ? 0 : 620 + Math.floor(r() * 220), outT = model === "rules" ? 0 : 110 + Math.floor(r() * 90);
      const todays = weekly.filter(x => x.days.includes(weekday));
      const deal = todays.length && r() < 0.8 ? pick(todays) : null;
      const sent = r() < 0.78;
      const cust = pick(seed.customers);
      const channel = r() < 0.7 ? "sms" as const : "email" as const;
      const dealId = deal ? `deal_${String(seed.deals.indexOf(deal) + 1).padStart(4, "0")}` : null;
      usage.push({ id: idOf("usage", usage.length), opportunityId: null, model, provider, inputTokens: inT, outputTokens: outT,
        costUsd: costUsd(model, inT, outT), priceVersion: PRICE_TABLE_VERSION, dealId, dealTitle: deal?.title ?? null,
        ledToSend: sent, sentChannel: sent ? channel : null, isDemo: true, createdAt: at.toISOString() });
      if (!sent) continue;
      const staff = Math.floor(r() * DEMO_STAFF.length);
      sends.push({ id: idOf("send", sends.length), deliveryId: null, userId: null, userLabel: DEMO_STAFF[staff], customerId: cust.id, channel,
        dealId, dealTitle: deal?.title ?? null, dealCategories: deal?.categories ?? [], dealProductIds: deal?.productIds ?? [], model,
        isDemo: true, createdAt: at.toISOString() });
      if (channel === "sms") {
        // Twilio US long code: $0.0083/segment + carrier fee ($0.0035–$0.0050). Sends from the last hour are still estimated.
        const segments = r() < 0.85 ? 1 : 2;
        const perSegment = 0.0083 + [0.0035, 0.0045, 0.005, 0.0042][Math.floor(r() * 4)];
        const estimated = nowMs - at.getTime() < 3_600_000;
        smsCosts.push({ id: idOf("sms", smsCosts.length), provider: "twilio", messageSid: `SMdemo${String(smsCosts.length).padStart(26, "0")}`, segments,
          priceUsd: Number((segments * (estimated ? 0.0125 : perSegment)).toFixed(4)), estimated, status: estimated ? "sent" : "delivered", isDemo: true, createdAt: at.toISOString() });
      }
      if (r() < STAFF_SKILL[staff] + (deal ? 0.06 : 0)) {
        const when = new Date(at.getTime() + (0.3 + r() * 6) * 86_400_000);
        if (when.getTime() > nowMs) continue;
        const cat = deal?.categories[0] ?? cust.profile.favoriteCategories[0] ?? null;
        const prod = seed.products.find(p => p.category === cat) ?? seed.products[0];
        purchases.push({ customerId: cust.id, purchaseId: idOf("purchase", purchases.length), purchasedAt: when.toISOString(),
          priceCents: 1800 + Math.floor(r() * 120) * 100, category: prod.category, productId: prod.id, isDemo: true });
      }
    }
  }
  return { usage, sends, purchases, smsCosts };
}
