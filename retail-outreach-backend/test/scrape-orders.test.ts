/**
 * scrape:quickvee:orders against the local mock of Orders Management (infinite scroll, date inputs, no export) with a
 * real Chromium: the CSV must be exactly what the manual order-history import accepts. Covers JSON (XHR) and DOM-only
 * modes, both channels, --limit, --resume, part-file rollover and the CLI.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { findChromium } from "../src/sync/quickvee/portal.js";
import { extractXhrOrders, parseItemLines } from "../src/sync/quickvee/orderCrawler.js";
import { OrderCsvWriter, parseScrapeArgs, scrapeOrderHistory } from "../src/orders/scrape.js";
import { ORDER_CSV_HEADERS, parseOrderCsv } from "../src/orders/csvImport.js";
import { MOCK_ORDERS, MOCK_USER, startMockPortal, syntheticOrders, type MockPortal } from "./fixtures/quickveePortal.js";
import { makeApp } from "./helpers.js";

const chromium = findChromium(process.env.QUICKVEE_CHROMIUM_PATH);
const run = promisify(execFile);

describe("scrape args", () => {
  it("parses flags with defaults (Jan 1 → Oct 31, in-store, no limit)", () => {
    expect(parseScrapeArgs(["--from", "2026-09-01", "--to", "2026-11-07", "--out", "o.csv", "--headed", "--channel", "both", "--limit", "1000", "--resume", "--details"]))
      .toEqual({ from: "2026-09-01", to: "2026-11-07", out: "o.csv", tz: undefined, headed: true, channel: "both", limit: 1000, resume: true, details: true });
    expect(parseScrapeArgs([])).toMatchObject({ from: "2026-01-01", to: "2026-10-31", channel: "in-store", limit: undefined, resume: false });
    expect(() => parseScrapeArgs(["--from", "2026-12-01", "--to", "2026-11-01"])).toThrow();
    expect(() => parseScrapeArgs(["--limit", "0"])).toThrow(/limit/);
    expect(() => parseScrapeArgs(["--channel", "web"])).toThrow(/channel/);
  });
  it("QUICKVEE_ORDER_LIMIT defaults to all", () => {
    expect(loadConfig({ NODE_ENV: "test" })).toMatchObject({ QUICKVEE_ORDER_LIMIT: 0, QUICKVEE_ORDER_CHANNEL: "in-store", QUICKVEE_BASE_URL: "https://quickvee.com" });
    expect(loadConfig({ NODE_ENV: "test", QUICKVEE_ORDER_LIMIT: "1000" }).QUICKVEE_ORDER_LIMIT).toBe(1000);
  });
});

describe("parsers", () => {
  it("reads Show Items lines in several shapes", () => {
    expect(parseItemLines(["Arturo Fuente", "2 x $9.50", "Papers", "Qty: 3", "$6.00", "1 x Lighter $1.99", "Vape", "$20.00", "Discount: $2.00"]).map(i => [i.name, i.quantity, i.unitPriceCents, i.discountCents]))
      .toEqual([["Arturo Fuente", 2, 950, 0], ["Papers", 3, 200, 0], ["Lighter", 1, 199, 0], ["Vape", 1, 2000, 200]]);
  });
  it("finds order-like objects in arbitrary JSON", () => {
    const [x] = extractXhrOrders({ data: { rows: [{ id: 5, order_id: "F3E37BE717735EA1", created_at: "10/31/2026 10:05 PM", grand_total: "25.50", customer_email: "A@B.co", status: "Refunded", items: [{ item_name: "Gum", qty: 2, price: 1.5 }] }] } });
    expect(x).toMatchObject({ ids: ["F3E37BE717735EA1"], total: 2550, email: "A@B.co", refunded: true, items: [{ name: "Gum", quantity: 2, unitPriceCents: 150 }] });
  });
});

// CI must exercise the crawler: there, a missing browser fails instead of skipping.
describe.skipIf(!chromium && !process.env.CI)("scrape:quickvee:orders (mock Orders Management, real Chromium)", () => {
  let json: MockPortal, dom: MockPortal, big: MockPortal, dir: string;
  beforeAll(async () => {
    json = await startMockPortal();
    dom = await startMockPortal({ json: false });
    big = await startMockPortal({ orders: [...MOCK_ORDERS, ...syntheticOrders(14)], ordersPageSize: 4 });
    dir = mkdtempSync(join(tmpdir(), "qv-scrape-"));
  });
  afterAll(async () => { await json?.close(); await dom?.close(); await big?.close(); rmSync(dir, { recursive: true, force: true }); });
  const env = (url: string) => ({ NODE_ENV: "test", QUICKVEE_STORE_NAME: MOCK_USER.storeName, QUICKVEE_USERNAME: MOCK_USER.username, QUICKVEE_PASSWORD: MOCK_USER.password, QUICKVEE_BASE_URL: url,
    QUICKVEE_STATE_DIR: join(dir, url.replace(/\W/g, "")), QUICKVEE_MIN_DELAY_MS: "0", QUICKVEE_SAVE_RAW: "false", QUICKVEE_STALL_SECONDS: "5",
    ...(chromium ? { QUICKVEE_CHROMIUM_PATH: chromium } : {}) });

  for (const mode of ["json", "dom"] as const) {
    it(`writes the manual-import format (${mode === "json" ? "list JSON + blocks" : "blocks only"}) and the import accepts it`, async () => {
      const { csv, orders } = await scrapeOrderHistory(loadConfig(env(mode === "json" ? json.url : dom.url)), { from: "2026-09-01", to: "2026-11-07", channel: "both" });
      expect(csv.split("\n")[0]).toBe(ORDER_CSV_HEADERS.join(","));
      expect(orders.map(o => o.externalId)).toEqual(["0A1B2C3D4E5F6071", "ABCDEF0123456789", "F3E37BE717735EA1", "90699FBBCCAF9E11"]);
      const parsed = parseOrderCsv(csv);
      expect(parsed.invalid).toEqual([]);
      expect(parsed.orders).toEqual(orders);
      const f3 = parsed.orders.find(o => o.externalId === "F3E37BE717735EA1")!;
      expect(f3).toMatchObject({ totalCents: 2000, discountCents: 100, subtotalCents: 2100, paymentMethod: "Card", at: "2026-11-02T15:15:00.000Z", customer: { name: "Jamal Carter" } });
      expect(f3.items.map(i => [i.name, i.quantity, i.unitPriceCents])).toEqual([["Arturo Fuente Hemingway", 2, 950], ["Zig-Zag Papers", 1, 200]]);
      expect(parsed.orders.find(o => o.externalId === "0A1B2C3D4E5F6071")).toMatchObject({ refunded: true, totalCents: 1799 });
      expect(parsed.orders.find(o => o.externalId === "90699FBBCCAF9E11")!.customer.name).toBeNull(); // Walk-In Customer
      if (mode === "json") { // contact details and brands come from the list API
        expect(f3.customer.phone).toBe("+15550100001");
        expect(f3.items[0].brand).toBe("Arturo Fuente");
      }
      const { app } = await makeApp();
      const pre = (await app.inject({ method: "POST", url: "/api/orders/import/preview", payload: { csv } })).json();
      expect(pre).toMatchObject({ newOrderCount: 4 });
      await app.close();
    }, 90_000);
  }

  it("in-store only by default; --details reads contact info from View Details", async () => {
    const { orders } = await scrapeOrderHistory(loadConfig(env(dom.url)), { from: "2026-09-01", to: "2026-11-07", details: true });
    expect(orders.map(o => o.externalId)).not.toContain("ABCDEF0123456789");
    expect(orders.find(o => o.externalId === "0A1B2C3D4E5F6071")!.customer.email).toBe("sarah@example.com");
  }, 90_000);

  it("infinite scroll reaches every order; --limit stops early; --resume continues without duplicates; files roll over", async () => {
    const cfg = loadConfig(env(big.url));
    const all = await scrapeOrderHistory(cfg, { from: "2026-01-01", to: "2026-10-31" });
    expect(all.orders).toHaveLength(14 + 1); // synthetic + the 09/20 order (others are outside the range or online)
    const out = join(dir, "resume.csv");
    const w1 = new OrderCsvWriter(out, false, 6);
    const first = await scrapeOrderHistory(cfg, { from: "2026-01-01", to: "2026-10-31", limit: 5, onOrders: b => w1.write(b) });
    expect(first.orders).toHaveLength(5);
    const w2 = new OrderCsvWriter(out, true, 6);
    expect(w2.seen.size).toBe(5);
    await scrapeOrderHistory(cfg, { from: "2026-01-01", to: w2.oldestDay!, seen: new Set(w2.seen), onOrders: b => w2.write(b) });
    expect(w2.files.length).toBeGreaterThan(1);
    expect(existsSync(w2.partPath(2))).toBe(true);
    const ids = w2.files.flatMap(f => parseOrderCsv(readFileSync(f, "utf8")).orders.map(o => o.externalId));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(all.orders.map(o => o.externalId).sort());
  }, 120_000);

  it("CLI writes --out with --limit, progress on stderr", async () => {
    const out = join(dir, "cli.csv");
    const { stdout, stderr } = await run("npx", ["tsx", "src/orders/scrapeCli.ts", "--from", "2026-01-01", "--to", "2026-10-31", "--limit", "3", "--out", out],
      { env: { ...process.env, ...env(big.url) }, cwd: process.cwd() });
    expect(stdout).toMatch(/Wrote 3 new orders/);
    expect(stderr).toMatch(/portal shows 15 orders/);
    expect(parseOrderCsv(readFileSync(out, "utf8")).orders).toHaveLength(3);
  }, 90_000);
});
