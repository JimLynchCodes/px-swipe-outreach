/** quickvee-rewards (CSV export, table crawl fallback) and quickvee-orders (Orders Management infinite-scroll crawler). */
import { addDays, isoDay, type JobContext, type JobDef } from "../job.js";
import { MfaRequiredError, portalConfig, QuickveePortal } from "./portal.js";
import { QV } from "./selectors.js";
import { parseCsv, toRewardsMember } from "./normalize.js";
import { crawlOrders } from "./orderCrawler.js";
import type { Order, RewardsMember } from "../types.js";

const missing = (c: import("../../config.js").AppConfig) => [!c.QUICKVEE_STORE_NAME && "QUICKVEE_STORE_NAME", !c.QUICKVEE_USERNAME && "QUICKVEE_USERNAME", !c.QUICKVEE_PASSWORD && "QUICKVEE_PASSWORD"].filter(Boolean) as string[];
const MAX_PAGES = 500;

async function withPortal<T>(ctx: JobContext, fn: (p: QuickveePortal) => Promise<T>): Promise<T> {
  ctx.progress({ phase: "Opening Quickvee" });
  const portal = await QuickveePortal.open(portalConfig(ctx.config), ctx.log);
  try {
    await portal.ensureLoggedIn();
    return await fn(portal);
  } catch (e) {
    if (e instanceof MfaRequiredError) ctx.log("error", e.message);
    throw e;
  } finally { await portal.close(); }
}

export async function scrapeRewards(ctx: JobContext, p: QuickveePortal): Promise<RewardsMember[]> {
  await p.goto(QV.paths.rewards(1));
  const csv = await p.exportCsv("rewards");
  let raw: Record<string, string>[];
  if (csv) { raw = parseCsv(csv); ctx.log("info", `Rewards CSV export: ${raw.length} rows`); }
  else {
    ctx.log("warn", "No rewards CSV export found; crawling the table");
    raw = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (page > 1) await p.goto(QV.paths.rewards(page));
      raw.push(...await p.readTable(QV.rewards.row, ["id", "name", "phone", "email", "points", "joined"], QV.rewards.cell));
      ctx.progress({ phase: "Crawling rewards", done: raw.length });
      if (!(await p.hasNext())) break;
    }
  }
  ctx.read(raw.length);
  const tz = await ctx.repo.getTimezone(ctx.orgId);
  return raw.map(r => toRewardsMember(r, tz)).filter((m): m is RewardsMember => !!m);
}

/**
 * Orders for [from, to] via the Orders Management crawler (infinite scroll; there is no export). Windows longer than a
 * year (the portal's limit) are split. `channel` both = In-Store then Online. Stops after `limit` new orders.
 */
export async function scrapeOrders(ctx: JobContext, p: QuickveePortal, from: string, to: string,
  o: { channel?: "in-store" | "online" | "both"; limit?: number; seen?: Set<string> } = {}): Promise<Order[]> {
  const tz = await ctx.repo.getTimezone(ctx.orgId);
  const out: Order[] = [];
  const channels = (o.channel ?? ctx.config.QUICKVEE_ORDER_CHANNEL) === "both" ? ["in-store", "online"] as const : [(o.channel ?? ctx.config.QUICKVEE_ORDER_CHANNEL) as "in-store" | "online"];
  for (const channel of channels) {
    for (const [a, b] of dateWindows(from, to, 365).reverse()) {
      const left = o.limit ? o.limit - out.length : undefined;
      if (left !== undefined && left <= 0) break;
      await crawlOrders(p, { from: a, to: b, channel, tz, limit: left, seen: o.seen, stallMs: ctx.config.QUICKVEE_STALL_SECONDS * 1000,
        log: ctx.log, progress: x => ctx.progress({ phase: `Orders ${a} → ${b} (${channel})`, done: x.done, total: x.expected ?? undefined }),
        onOrders: batch => { out.push(...batch); } });
    }
  }
  ctx.read(out.length);
  return out;
}

export const quickveeRewardsJob: JobDef = {
  id: "quickvee-rewards",
  label: "Quickvee rewards",
  description: "Rewards members: name, contact, points and signup date, matched to customers by phone/email.",
  missingEnv: missing,
  async run(ctx) {
    const members = await withPortal(ctx, p => scrapeRewards(ctx, p));
    ctx.progress({ phase: "Saving", done: 0, total: members.length });
    const r = await ctx.repo.upsertRewardsMembers(ctx.orgId, members);
    ctx.wrote(r.inserted + r.updated);
    ctx.log("info", `${members.length} rewards members: ${r.matched ?? 0} matched existing customers, ${r.inserted} new`);
    if (!ctx.dryRun) await ctx.repo.setWatermark(ctx.orgId, "quickvee-rewards", ctx.now.toISOString());
    ctx.progress({ phase: "Done", done: members.length, total: members.length });
  }
};

/** Splits [from, to] (inclusive days) into windows of `days`. */
export function dateWindows(from: string, to: string, days: number): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let a = from; a <= to; a = addDays(a, days)) { const b = addDays(a, days - 1); out.push([a, b < to ? b : to]); }
  return out;
}

export const quickveeOrdersJob: JobDef = {
  id: "quickvee-orders",
  label: "Quickvee orders",
  description: "Orders with line items, categories, discounts and payment. Recent orders on schedule; deep history via Backfill.",
  supportsBackfill: true,
  missingEnv: missing,
  async run(ctx) {
    const today = isoDay(ctx.now);
    const backfill = typeof ctx.params.from === "string";
    const wm = await ctx.repo.getWatermark(ctx.orgId, "quickvee-orders");
    const from = backfill ? String(ctx.params.from) : wm ? addDays(wm, -1) : addDays(today, -30);
    const to = typeof ctx.params.to === "string" ? String(ctx.params.to) : today;
    const windows = dateWindows(from, to, ctx.config.QUICKVEE_CHUNK_DAYS);
    const limit = ctx.config.QUICKVEE_ORDER_LIMIT || undefined;
    const seen = new Set<string>();
    let total = 0;
    await withPortal(ctx, async p => {
      for (const [i, [a, b]] of windows.entries()) {
        ctx.progress({ phase: `Orders ${a} → ${b}`, done: i, total: windows.length });
        if (limit && total >= limit) { ctx.log("info", `Stopped at QUICKVEE_ORDER_LIMIT=${limit}`); break; }
        const orders = await scrapeOrders(ctx, p, a, b, { limit: limit ? limit - total : undefined, seen });
        const r = await ctx.repo.upsertOrders(ctx.orgId, orders);
        total += orders.length;
        ctx.wrote(r.inserted + r.updated);
        ctx.log("info", `${a} → ${b}: ${orders.length} orders (${r.inserted} new, ${r.updated} updated, ${r.skipped ?? 0} without a customer)`);
        // Incremental runs advance the watermark per window so a failure resumes where it stopped. Backfills leave it alone.
        const limited = !!limit && total >= limit; // a cut-short window isn't complete: don't advance past it
        if (!ctx.dryRun && !backfill && !limited && (!wm || b > wm) && b <= today) await ctx.repo.setWatermark(ctx.orgId, "quickvee-orders", b);
      }
    });
    ctx.progress({ phase: "Done", done: windows.length, total: windows.length });
    ctx.log("info", `${total} orders synced (${from} → ${to})`);
  }
};
