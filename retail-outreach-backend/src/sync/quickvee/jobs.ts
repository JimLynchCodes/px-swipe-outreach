/** quickvee-rewards and quickvee-orders: CSV export first, table crawl as the fallback. */
import { addDays, isoDay, type JobContext, type JobDef } from "../job.js";
import { MfaRequiredError, portalConfig, QuickveePortal } from "./portal.js";
import { QV } from "./selectors.js";
import { parseCsv, toOrders, toRewardsMember } from "./normalize.js";
import type { Order, RewardsMember } from "../types.js";

const missing = (c: import("../../config.js").AppConfig) => [!c.QUICKVEE_EMAIL && "QUICKVEE_EMAIL", !c.QUICKVEE_PASSWORD && "QUICKVEE_PASSWORD"].filter(Boolean) as string[];
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

export async function scrapeOrders(ctx: JobContext, p: QuickveePortal, from: string, to: string): Promise<Order[]> {
  await p.goto(QV.paths.orders(from, to, 1));
  const csv = await p.exportCsv(`orders-${from}_${to}`);
  const tz = await ctx.repo.getTimezone(ctx.orgId);
  if (csv) { const rows = parseCsv(csv); ctx.read(rows.length); return toOrders(rows, tz); }
  ctx.log("warn", `No orders CSV export for ${from}..${to}; crawling`);
  const headers: Array<Record<string, string>> = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (page > 1) await p.goto(QV.paths.orders(from, to, page));
    headers.push(...await p.readTable(QV.orders.row, ["orderId", "date", "customer", "phone", "email", "subtotal", "discount", "total", "payment"], QV.orders.cell, QV.orders.detailLink));
    if (!(await p.hasNext())) break;
  }
  const lines: Record<string, string>[] = [];
  for (const h of headers) {
    const base = { order_id: h.orderId, date: h.date, customer_name: h.customer, phone: h.phone, email: h.email, subtotal: h.subtotal, order_discount: h.discount, total: h.total, payment: h.payment };
    if (h._href) {
      await p.goto(h._href);
      const items = await p.readTable(QV.orderItems.row, ["name", "sku", "category", "brand", "qty", "price", "discount"], QV.orderItems.cell);
      for (const i of items) lines.push({ ...base, item: i.name, sku: i.sku, category: i.category, brand: i.brand, qty: i.qty, unit_price: i.price, item_discount: i.discount });
      if (!items.length) lines.push(base);
    } else lines.push(base);
  }
  ctx.read(headers.length);
  return toOrders(lines, tz);
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
    let total = 0;
    await withPortal(ctx, async p => {
      for (const [i, [a, b]] of windows.entries()) {
        ctx.progress({ phase: `Orders ${a} → ${b}`, done: i, total: windows.length });
        const orders = await scrapeOrders(ctx, p, a, b);
        const r = await ctx.repo.upsertOrders(ctx.orgId, orders);
        total += orders.length;
        ctx.wrote(r.inserted + r.updated);
        ctx.log("info", `${a} → ${b}: ${orders.length} orders (${r.inserted} new, ${r.updated} updated, ${r.skipped ?? 0} without a customer)`);
        // Incremental runs advance the watermark per window so a failure resumes where it stopped. Backfills leave it alone.
        if (!ctx.dryRun && !backfill && (!wm || b > wm) && b <= today) await ctx.repo.setWatermark(ctx.orgId, "quickvee-orders", b);
      }
    });
    ctx.progress({ phase: "Done", done: windows.length, total: windows.length });
    ctx.log("info", `${total} orders synced (${from} → ${to})`);
  }
};
