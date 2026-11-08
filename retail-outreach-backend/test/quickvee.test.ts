/**
 * Quickvee scraper against the local mock portal with a real Chromium (Playwright). Skipped when no Chromium is found
 * (set QUICKVEE_CHROMIUM_PATH). Covers rewards CSV export, the orders crawler (via the sync job), session reuse,
 * MFA stop, bad credentials, and that credentials never reach the run log.
 */
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { MemorySyncRepo } from "../src/sync/memoryRepo.js";
import { SyncRunner } from "../src/sync/runner.js";
import { findChromium } from "../src/sync/quickvee/portal.js";
import { MOCK_USER, startMockPortal, type MockPortal } from "./fixtures/quickveePortal.js";

const ORG = "00000000-0000-4000-8000-000000000001";
const chromium = findChromium(process.env.QUICKVEE_CHROMIUM_PATH);

// CI must exercise the scraper: there, a missing browser fails instead of skipping.
describe.skipIf(!chromium && !process.env.CI)("Quickvee scraper (mock portal, real Chromium)", () => {
  let portal: MockPortal;
  beforeAll(async () => { portal = await startMockPortal({ pageSize: 2 }); });
  afterAll(async () => { await portal?.close(); });

  const run = async (job: "quickvee-rewards" | "quickvee-orders", o: { url?: string; stateDir?: string; password?: string; params?: Record<string, unknown>; repo?: MemorySyncRepo; env?: Record<string, string> } = {}) => {
    const stateDir = o.stateDir ?? mkdtempSync(path.join(tmpdir(), "qv-"));
    const config = loadConfig({ NODE_ENV: "test", QUICKVEE_STORE_NAME: MOCK_USER.storeName, QUICKVEE_USERNAME: MOCK_USER.username, QUICKVEE_PASSWORD: o.password ?? MOCK_USER.password, QUICKVEE_BASE_URL: o.url ?? portal.url,
      QUICKVEE_STATE_DIR: stateDir, QUICKVEE_MIN_DELAY_MS: "0", QUICKVEE_CHUNK_DAYS: "31", QUICKVEE_STALL_SECONDS: "5", ...o.env, ...(chromium ? { QUICKVEE_CHROMIUM_PATH: chromium } : {}) });
    const repo = o.repo ?? new MemorySyncRepo();
    const runner = new SyncRunner(repo, config, { now: () => new Date("2026-11-07T17:00:00Z") });
    const r = await runner.start({ orgId: ORG, job, trigger: "manual", params: o.params });
    await runner.wait(r.id);
    return { repo, stateDir, run: (await repo.getRun(ORG, r.id))! };
  };

  it("rewards via CSV export; session persists and is reused; raw snapshot saved", async () => {
    const { repo, stateDir, run: r } = await run("quickvee-rewards");
    expect(r.status, r.error ?? "").toBe("succeeded");
    const members = [...repo.customers.values()];
    expect(members).toHaveLength(3);
    expect(members.find(m => m.externalId === "R101")).toMatchObject({ email: "sarah@example.com", phone: "+15550100002", points: 1200, joinedAt: "2024-11-02", firstName: "Sarah" });
    expect(existsSync(path.join(stateDir, "session.json"))).toBe(true);
    expect(readdirSync(path.join(stateDir, "raw")).some(f => f.endsWith("rewards.csv"))).toBe(true);
    const logins = portal.logins;
    const again = await run("quickvee-rewards", { stateDir });
    expect(again.run.status).toBe("succeeded");
    expect(portal.logins).toBe(logins); // cookie reused, no new login
    expect(JSON.stringify(again.run.log) + JSON.stringify(r.log)).not.toContain(MOCK_USER.password);
    expect(JSON.stringify(r.log)).not.toContain(MOCK_USER.username);
    expect(JSON.stringify(r.log)).not.toContain(MOCK_USER.storeName);
  }, 60_000);

  it("orders: date-range backfill via the Orders Management crawler; walk-ins skipped, watermark untouched by backfill", async () => {
    const { repo, run: r } = await run("quickvee-orders", { params: { from: "2026-09-01", to: "2026-11-07" } });
    expect(r.status, r.error ?? "").toBe("succeeded");
    const orders = [...repo.orders.values()];
    expect(orders.map(o => o.externalId).sort()).toEqual(["0A1B2C3D4E5F6071", "F3E37BE717735EA1"]); // in-store; the walk-in has no customer
    const o = orders.find(x => x.externalId === "F3E37BE717735EA1")!;
    expect(o).toMatchObject({ totalCents: 2000, discountCents: 100, paymentMethod: "Card", at: "2026-11-02T15:15:00.000Z" });
    expect(o.items.map(i => [i.name, i.quantity, i.unitPriceCents, i.category])).toEqual([["Arturo Fuente Hemingway", 2, 950, "Cigars"], ["Zig-Zag Papers", 1, 200, "Papers"]]);
    expect(await repo.getWatermark(ORG, "quickvee-orders")).toBeNull();
  }, 60_000);

  it("orders: incremental run advances the watermark; QUICKVEE_ORDER_LIMIT stops early and holds it", async () => {
    const od = await run("quickvee-orders");
    expect(od.run.status, od.run.error ?? "").toBe("succeeded");
    expect(await od.repo.getWatermark(ORG, "quickvee-orders")).toBe("2026-11-07");
    const lim = await run("quickvee-orders", { env: { QUICKVEE_ORDER_LIMIT: "1" }, params: { from: "2026-09-01", to: "2026-11-07" } });
    expect(lim.run.status, lim.run.error ?? "").toBe("succeeded");
    expect(lim.repo.orders.size).toBe(1);
  }, 60_000);

  it("rewards crawl fallback when there's no export: paginates the table", async () => {
    const crawl = await startMockPortal({ csv: false, pageSize: 1 });
    try {
      const rw = await run("quickvee-rewards", { url: crawl.url });
      expect(rw.run.status, rw.run.error ?? "").toBe("succeeded");
      expect(rw.repo.customers.size).toBe(3);
      expect(crawl.requests.filter(q => q.startsWith("GET /rewards?page=")).length).toBe(3);
    } finally { await crawl.close(); }
  }, 60_000);

  it("stops clearly when MFA is required (headless) and on bad credentials", async () => {
    const mfa = await startMockPortal({ mfa: true });
    try {
      const r = await run("quickvee-rewards", { url: mfa.url });
      expect(r.run.status).toBe("failed");
      expect(r.run.error).toMatch(/MFA/);
    } finally { await mfa.close(); }
    const bad = await run("quickvee-rewards", { password: "wrong-password" });
    expect(bad.run).toMatchObject({ status: "failed" });
    expect(bad.run.error).toMatch(/login failed/i);
    expect(JSON.stringify(bad.run)).not.toContain("wrong-password");
  }, 60_000);
});
