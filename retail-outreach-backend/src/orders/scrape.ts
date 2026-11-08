/**
 * Scrape Quickvee order history (Orders Management, infinite scroll; there is no export) to a CSV in exactly the format
 * Data sync → Manually add → Order history accepts: one row per line item (one row when an order has no items).
 *
 *   npm run scrape:quickvee:orders -- --from 2026-01-01 --to 2026-10-31 --out orders.csv
 *     [--channel in-store|online|both] [--limit N] [--resume] [--details] [--headed] [--tz America/New_York]
 *
 * Writes as it goes; --resume skips orders already in the output file(s), so a crash loses nothing. Files roll over to
 * orders.part2.csv, … before the import's per-upload row limit. Progress goes to stderr.
 * Needs QUICKVEE_STORE_NAME / QUICKVEE_USERNAME / QUICKVEE_PASSWORD in the environment (e.g. --env-file=.env.local).
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AppConfig } from "../config.js";
import { isoDay } from "../sync/job.js";
import { MfaRequiredError, portalConfig, QuickveePortal } from "../sync/quickvee/portal.js";
import { crawlOrders, type Channel } from "../sync/quickvee/orderCrawler.js";
import { dateWindows } from "../sync/quickvee/jobs.js";
import { parseCsv, toIso } from "../sync/quickvee/normalize.js";
import type { Order } from "../sync/types.js";
import { MAX_ORDER_ROWS, ordersToCsv } from "./csvImport.js";

export type ScrapeOptions = {
  from: string; to: string; tz?: string; headed?: boolean; channel?: Channel | "both"; limit?: number; details?: boolean;
  /** Called with each batch as it's captured. */
  onOrders?: (orders: Order[]) => void;
  /** Order IDs to skip (resume). */
  seen?: Set<string>;
  log?: (level: "info" | "warn" | "error", msg: string) => void;
};

/** Crawls and returns the orders (also streamed to onOrders). Windows run newest first, like the portal's list. */
export async function scrapeOrderHistory(config: AppConfig, o: ScrapeOptions): Promise<{ csv: string; orders: Order[] }> {
  const log = o.log ?? (() => {});
  const tz = o.tz ?? "America/New_York";
  const portal = await QuickveePortal.open({ ...portalConfig(config), ...(o.headed ? { headless: false } : {}) }, (l, m) => log(l, m));
  const orders: Order[] = [];
  const seen = o.seen ?? new Set<string>();
  try {
    await portal.ensureLoggedIn();
    const channels: Channel[] = o.channel === "both" ? ["in-store", "online"] : [o.channel ?? "in-store"];
    outer: for (const channel of channels) {
      for (const [a, b] of dateWindows(o.from, o.to, 365).reverse()) {
        const left = o.limit ? o.limit - orders.length : undefined;
        if (left !== undefined && left <= 0) break outer;
        const r = await crawlOrders(portal, {
          from: a, to: b, channel, tz, limit: left, seen, details: o.details, stallMs: config.QUICKVEE_STALL_SECONDS * 1000, log,
          progress: p => log("info", `  ${channel} ${a} → ${b}: ${p.done}${p.expected !== null ? `/${p.expected}` : ""} orders read, ${orders.length} new`),
          onOrders: batch => { orders.push(...batch); o.onOrders?.(batch); }
        });
        if (r.stoppedByLimit) { log("info", `Stopped at --limit ${o.limit}`); break outer; }
      }
    }
  } finally { await portal.close(); }
  orders.sort((x, y) => x.at.localeCompare(y.at) || x.externalId.localeCompare(y.externalId));
  return { csv: ordersToCsv(orders), orders };
}

/** Appends orders to out.csv, rolling over to out.part2.csv … below the import's row limit. Supports resume. */
export class OrderCsvWriter {
  readonly seen = new Set<string>();
  private file: string;
  private rows = 0;
  private part = 1;
  oldestDay: string | null = null;
  constructor(private out: string, resume: boolean, private maxRows = Math.floor(MAX_ORDER_ROWS * 0.9), tz?: string) {
    this.file = out;
    if (resume) {
      for (let n = 1; existsSync(this.partPath(n)); n++) {
        const rows = parseCsv(readFileSync(this.partPath(n), "utf8"));
        for (const r of rows) {
          if (r["Order ID"]) this.seen.add(r["Order ID"]);
          const day = toIso(r.Date, tz)?.slice(0, 10);
          if (day && (!this.oldestDay || day < this.oldestDay)) this.oldestDay = day;
        }
        this.part = n; this.file = this.partPath(n); this.rows = rows.length;
      }
    }
    if (!resume || !existsSync(this.file)) { writeFileSync(this.file, ordersToCsv([])); this.rows = 0; }
  }
  partPath(n: number) { return n === 1 ? this.out : this.out.replace(/(\.csv)?$/i, `.part${n}.csv`); }
  get files() { return Array.from({ length: this.part }, (_, i) => this.partPath(i + 1)); }
  write(orders: Order[]) {
    for (const o of orders) {
      if (this.seen.has(o.externalId)) continue;
      const lines = ordersToCsv([o]).trimEnd().split("\n").slice(1);
      if (this.rows && this.rows + lines.length > this.maxRows) {
        this.part++; this.file = this.partPath(this.part); writeFileSync(this.file, ordersToCsv([])); this.rows = 0;
      }
      appendFileSync(this.file, lines.join("\n") + "\n");
      this.rows += lines.length;
      this.seen.add(o.externalId);
    }
  }
}

export function parseScrapeArgs(argv: string[], _today = isoDay(new Date())) {
  const flag = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const from = flag("from") ?? "2026-01-01";
  const to = flag("to") ?? "2026-10-31";
  if (!day.test(from) || !day.test(to) || from > to) throw new Error("--from and --to must be YYYY-MM-DD with from ≤ to");
  const channel = (flag("channel") ?? "in-store").toLowerCase();
  if (!["in-store", "online", "both"].includes(channel)) throw new Error("--channel must be in-store, online or both");
  const limitRaw = flag("limit");
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error("--limit must be a positive whole number");
  return { from, to, out: flag("out") ?? `quickvee-orders-${from}_${to}.csv`, tz: flag("tz"), headed: argv.includes("--headed"),
    channel: channel as Channel | "both", limit, resume: argv.includes("--resume"), details: argv.includes("--details") };
}
export { MfaRequiredError };
