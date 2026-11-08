/**
 * scrape:quickvee:orders against the local mock portal with a real Chromium: the CSV it writes must be exactly what the
 * manual order-history import accepts (and imports). Skipped when no Chromium is found (set QUICKVEE_CHROMIUM_PATH).
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { findChromium } from "../src/sync/quickvee/portal.js";
import { parseScrapeArgs, scrapeOrderHistory } from "../src/orders/scrape.js";
import { ORDER_CSV_HEADERS, parseOrderCsv } from "../src/orders/csvImport.js";
import { MOCK_USER, startMockPortal, type MockPortal } from "./fixtures/quickveePortal.js";
import { makeApp } from "./helpers.js";

const chromium = findChromium(process.env.QUICKVEE_CHROMIUM_PATH);

describe("scrape args", () => {
  it("parses flags with sensible defaults", () => {
    expect(parseScrapeArgs(["--from", "2026-09-01", "--to", "2026-11-07", "--out", "o.csv", "--headed"]))
      .toEqual({ from: "2026-09-01", to: "2026-11-07", out: "o.csv", tz: undefined, headed: true });
    expect(parseScrapeArgs([], "2026-11-07")).toMatchObject({ from: "2026-10-08", to: "2026-11-07", out: "quickvee-orders-2026-10-08_2026-11-07.csv", headed: false });
    expect(() => parseScrapeArgs(["--from", "2026-12-01", "--to", "2026-11-01"])).toThrow();
  });
});

describe.skipIf(!chromium && !process.env.CI)("scrape:quickvee:orders (mock portal, real Chromium)", () => {
  let portal: MockPortal, crawl: MockPortal, dir: string;
  beforeAll(async () => { portal = await startMockPortal(); crawl = await startMockPortal({ csv: false, pageSize: 1 }); dir = mkdtempSync(join(tmpdir(), "qv-scrape-")); });
  afterAll(async () => { await portal?.close(); await crawl?.close(); rmSync(dir, { recursive: true, force: true }); });
  const env = (url: string) => ({ NODE_ENV: "test", QUICKVEE_STORE_NAME: MOCK_USER.storeName, QUICKVEE_USERNAME: MOCK_USER.username, QUICKVEE_PASSWORD: MOCK_USER.password, QUICKVEE_BASE_URL: url,
    QUICKVEE_STATE_DIR: join(dir, url.replace(/\W/g, "")), QUICKVEE_MIN_DELAY_MS: "0", QUICKVEE_CHUNK_DAYS: "31", QUICKVEE_SAVE_RAW: "false",
    ...(chromium ? { QUICKVEE_CHROMIUM_PATH: chromium } : {}) });

  for (const mode of ["csv export", "table crawl"] as const) {
    it(`writes the manual-import format (${mode}) and the import accepts it`, async () => {
      const { csv, orders } = await scrapeOrderHistory(loadConfig(env(mode === "csv export" ? portal.url : crawl.url)), { from: "2026-09-01", to: "2026-11-07" });
      expect(csv.split("\n")[0]).toBe(ORDER_CSV_HEADERS.join(","));
      expect(orders.map(o => o.externalId)).toEqual(["O-8800", "O-9001", "O-9002"]);
      const parsed = parseOrderCsv(csv);
      expect(parsed.invalid).toEqual([]);
      expect(parsed.orders).toEqual(orders);
      expect(parsed.orders.find(o => o.externalId === "O-9001")).toMatchObject({ totalCents: 2000, discountCents: 100, at: "2026-11-02T15:15:00.000Z" });

      const { app } = await makeApp();
      const pre = (await app.inject({ method: "POST", url: "/api/orders/import/preview", payload: { csv } })).json();
      expect(pre).toMatchObject({ newOrderCount: 3, links: { unlinked: 1 } }); // O-9002 is a walk-in
      expect((await app.inject({ method: "POST", url: "/api/orders/import", payload: { csv } })).json()).toMatchObject({ inserted: 2, unlinked: 1 });
      await app.close();
    }, 90_000);
  }

  it("CLI writes --out", async () => {
    const out = join(dir, "orders.csv");
    const { stdout } = await promisify(execFile)("npx", ["tsx", "src/orders/scrapeCli.ts", "--from", "2026-09-01", "--to", "2026-11-07", "--out", out],
      { env: { ...process.env, ...env(portal.url) }, cwd: process.cwd() });
    expect(stdout).toMatch(/Wrote 3 orders \(4 line items\)/);
    expect(parseOrderCsv(readFileSync(out, "utf8")).orders).toHaveLength(3);
  }, 90_000);
});
