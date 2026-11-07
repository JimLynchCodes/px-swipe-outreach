/**
 * Scrape Quickvee order history to a CSV in exactly the format Data sync → Manually add (order history) accepts.
 * Reuses the data-sync Playwright scraper (CSV export first, table crawl fallback, saved session, MFA stop, rate limit).
 *
 *   npm run scrape:quickvee:orders -- --from 2026-01-01 --to 2026-11-07 --out orders.csv [--headed] [--tz America/New_York]
 *
 * Needs QUICKVEE_EMAIL / QUICKVEE_PASSWORD (and QUICKVEE_BASE_URL for the real portal) in the environment, e.g. --env-file=.env.local.
 */
import type { AppConfig } from "../config.js";
import { addDays, isoDay, type JobContext } from "../sync/job.js";
import { MfaRequiredError, portalConfig, QuickveePortal } from "../sync/quickvee/portal.js";
import { dateWindows, scrapeOrders } from "../sync/quickvee/jobs.js";
import type { Order } from "../sync/types.js";
import { ordersToCsv } from "./csvImport.js";

export type ScrapeOptions = { from: string; to: string; tz?: string; headed?: boolean; log?: (level: "info" | "warn" | "error", msg: string) => void };

export async function scrapeOrderHistory(config: AppConfig, o: ScrapeOptions): Promise<{ csv: string; orders: Order[] }> {
  const log = o.log ?? (() => {});
  const tz = o.tz ?? "America/New_York";
  const ctx = {
    orgId: "cli", params: {}, dryRun: true, config, fetchImpl: fetch, retry: { retries: 0 } as never, now: new Date(),
    repo: { getTimezone: async () => tz } as unknown as JobContext["repo"],
    log: (level: "info" | "warn" | "error" | "debug", msg: string) => log(level === "debug" ? "info" : level, msg),
    progress: () => {}, read: () => {}, wrote: () => {}
  } as JobContext;
  const portal = await QuickveePortal.open({ ...portalConfig(config), ...(o.headed ? { headless: false } : {}) }, ctx.log);
  const byId = new Map<string, Order>();
  try {
    await portal.ensureLoggedIn();
    for (const [a, b] of dateWindows(o.from, o.to, config.QUICKVEE_CHUNK_DAYS)) {
      const orders = await scrapeOrders(ctx, portal, a, b);
      for (const x of orders) byId.set(x.externalId, x); // windows can overlap at the edges
      log("info", `${a} → ${b}: ${orders.length} orders`);
    }
  } finally { await portal.close(); }
  const orders = [...byId.values()].sort((x, y) => x.at.localeCompare(y.at) || x.externalId.localeCompare(y.externalId));
  return { csv: ordersToCsv(orders), orders };
}

export function parseScrapeArgs(argv: string[], today = isoDay(new Date())) {
  const flag = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const to = flag("to") ?? today;
  const from = flag("from") ?? addDays(to, -30);
  if (!day.test(from) || !day.test(to) || from > to) throw new Error("--from and --to must be YYYY-MM-DD with from ≤ to");
  return { from, to, out: flag("out") ?? `quickvee-orders-${from}_${to}.csv`, tz: flag("tz"), headed: argv.includes("--headed") };
}
export { MfaRequiredError };
