/**
 * Quickvee merchant portal driver (Playwright). Scrape ONLY with the merchant's own account.
 *  - Credentials come from env (QUICKVEE_STORE_NAME / QUICKVEE_USERNAME / QUICKVEE_PASSWORD) and are never logged.
 *  - The session (cookies) persists in QUICKVEE_STATE_DIR/session.json, so logins are rare.
 *  - If Quickvee asks for MFA: headless runs stop with MfaRequiredError; a headed run (QUICKVEE_HEADLESS=false) waits
 *    up to 5 minutes for you to finish it in the browser, then saves the session.
 *  - Polite: at most one navigation per QUICKVEE_MIN_DELAY_MS.
 *  - Raw snapshots (CSV / page HTML) go to QUICKVEE_STATE_DIR/raw/ (gitignored, may contain customer PII).
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../../config.js";
import { QV } from "./selectors.js";

export class MfaRequiredError extends Error {
  constructor() {
    super("Quickvee asked for a verification code (MFA). Run the sync once headed (QUICKVEE_HEADLESS=false npm run sync -- quickvee-rewards) and complete it in the browser; the session is then saved.");
    this.name = "MfaRequiredError";
  }
}
export class LoginFailedError extends Error { constructor(m = "Quickvee login failed: check QUICKVEE_STORE_NAME / QUICKVEE_USERNAME / QUICKVEE_PASSWORD.") { super(m); this.name = "ConfigError"; } }

type Page = import("playwright-core").Page;
type Browser = import("playwright-core").Browser;
type Context = import("playwright-core").BrowserContext;
type Log = (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => void;

const CHROMIUM_CANDIDATES = ["/usr/bin/chromium-browser", "/usr/bin/chromium", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"];
export const findChromium = (explicit?: string) => explicit ?? CHROMIUM_CANDIDATES.find(p => existsSync(p));

export class QuickveePortal {
  private last = 0;
  private constructor(private browser: Browser, private context: Context, readonly page: Page, private cfg: PortalConfig, private log: Log) {}

  static async open(cfg: PortalConfig, log: Log): Promise<QuickveePortal> {
    const { chromium } = await import("playwright-core");
    const executablePath = findChromium(cfg.chromiumPath);
    if (!executablePath) throw new Error("No Chromium found for Quickvee. Set QUICKVEE_CHROMIUM_PATH (the Docker image ships /usr/bin/chromium-browser).");
    const browser = await chromium.launch({ headless: cfg.headless, executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    await mkdir(cfg.stateDir, { recursive: true, mode: 0o700 });
    const session = path.join(cfg.stateDir, "session.json");
    const context = await browser.newContext({ acceptDownloads: true, storageState: existsSync(session) ? session : undefined, userAgent: undefined });
    const page = await context.newPage();
    page.setDefaultTimeout(cfg.timeoutMs);
    return new QuickveePortal(browser, context, page, cfg, log);
  }

  private async throttle() {
    const wait = this.last + this.cfg.minDelayMs - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this.last = Date.now();
  }
  async goto(rel: string) {
    await this.throttle();
    await this.page.goto(new URL(rel, this.cfg.baseUrl).toString(), { waitUntil: "domcontentloaded" });
  }

  async ensureLoggedIn() {
    await this.goto(QV.paths.home);
    if (await this.page.locator(QV.loggedIn).count()) { this.log("info", "Quickvee session reused"); return; }
    this.log("info", "Logging in to Quickvee");
    if (!this.page.url().includes(QV.paths.login)) await this.goto(QV.paths.login);
    await this.fillField(QV.login.storeName, this.cfg.storeName, "Store name");
    await this.fillField(QV.login.username, this.cfg.username, "Username");
    await this.fillField(QV.login.password, this.cfg.password, "Password");
    await this.throttle();
    await this.page.click(QV.login.submit);
    const outcome = await Promise.race([
      this.page.waitForSelector(QV.loggedIn).then(() => "ok" as const),
      this.page.waitForSelector(QV.login.mfa).then(() => "mfa" as const),
      this.page.waitForSelector(QV.login.error).then(() => "error" as const)
    ]).catch(() => "timeout" as const);
    if (outcome === "error" || outcome === "timeout") throw new LoginFailedError(outcome === "timeout" ? "Quickvee login didn't finish: selectors may need calibrating (see docs/DATA_SYNC.md)." : undefined);
    if (outcome === "mfa") {
      if (this.cfg.headless) throw new MfaRequiredError();
      this.log("warn", "Quickvee MFA: complete it in the browser window (waiting up to 5 minutes)");
      await this.page.waitForSelector(QV.loggedIn, { timeout: 5 * 60_000 });
    }
    await this.context.storageState({ path: path.join(this.cfg.stateDir, "session.json") });
    this.log("info", "Quickvee session saved");
  }

  /** Fills a login field found by label, then placeholder, then name/id. Values are never logged. */
  private async fillField(f: { label: RegExp; placeholder: RegExp; css: string }, value: string, name: string) {
    const loc = this.page.getByLabel(f.label).or(this.page.getByPlaceholder(f.label)).or(this.page.getByPlaceholder(f.placeholder))
      .or(this.page.locator(f.css)).first();
    if (!(await loc.count())) throw new LoginFailedError(`Quickvee login page has no "${name}" field: selectors may need calibrating (see docs/DATA_SYNC.md).`);
    await loc.fill(value);
  }

  /** Clicks the export control and returns the downloaded CSV, or null when there's no export on this page. */
  async exportCsv(snapshotName: string): Promise<string | null> {
    const btn = this.page.locator(QV.exportCsv).first();
    if (!(await btn.count())) return null;
    await this.throttle();
    const [dl] = await Promise.all([this.page.waitForEvent("download", { timeout: this.cfg.timeoutMs }), btn.click()]);
    const file = await dl.path();
    if (!file) return null;
    const text = await readFile(file, "utf8");
    await this.snapshot(`${snapshotName}.csv`, text);
    return text;
  }

  /** Reads a table into rows of { col: text } using data-col cells. */
  async readTable(rowSel: string, cols: string[], cell: (c: string) => string, linkSel?: string): Promise<Array<Record<string, string>>> {
    return this.page.$$eval(rowSel, (rows, a) => rows.map(r => {
      const o: Record<string, string> = {};
      for (const c of a.cols) o[c] = (r.querySelector(a.cells[c])?.textContent ?? "").trim();
      if (a.linkSel) o._href = (r.querySelector(a.linkSel) as HTMLAnchorElement | null)?.getAttribute("href") ?? "";
      return o;
    }), { cols, cells: Object.fromEntries(cols.map(c => [c, cell(c)])), linkSel: linkSel ?? null });
  }
  hasNext = async () => (await this.page.locator(QV.nextPage).count()) > 0;

  async snapshot(name: string, body: string) {
    if (!this.cfg.saveRaw) return;
    const dir = path.join(this.cfg.stateDir, "raw");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${name}`), body, { mode: 0o600 });
  }

  async close() { await this.context.close().catch(() => {}); await this.browser.close().catch(() => {}); }
}

export type PortalConfig = { baseUrl: string; storeName: string; username: string; password: string; stateDir: string; headless: boolean; minDelayMs: number; timeoutMs: number; chromiumPath?: string; saveRaw: boolean };
export const portalConfig = (c: AppConfig): PortalConfig => ({
  baseUrl: c.QUICKVEE_BASE_URL, storeName: c.QUICKVEE_STORE_NAME ?? "", username: c.QUICKVEE_USERNAME ?? "", password: c.QUICKVEE_PASSWORD ?? "", stateDir: c.QUICKVEE_STATE_DIR,
  headless: c.QUICKVEE_HEADLESS, minDelayMs: c.QUICKVEE_MIN_DELAY_MS, timeoutMs: 30_000, chromiumPath: c.QUICKVEE_CHROMIUM_PATH, saveRaw: c.QUICKVEE_SAVE_RAW
});
