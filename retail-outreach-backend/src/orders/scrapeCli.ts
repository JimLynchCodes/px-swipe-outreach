import { writeFileSync } from "node:fs";
import { loadConfigOrExit } from "../config.js";
import { MfaRequiredError, parseScrapeArgs, scrapeOrderHistory } from "./scrape.js";

let args;
try { args = parseScrapeArgs(process.argv.slice(2)); } catch (e) {
  console.error(`${(e as Error).message}\nUsage: npm run scrape:quickvee:orders -- --from YYYY-MM-DD --to YYYY-MM-DD --out orders.csv [--headed] [--tz America/New_York]`);
  process.exit(2);
}
const config = loadConfigOrExit();
if (!config.QUICKVEE_STORE_NAME || !config.QUICKVEE_USERNAME || !config.QUICKVEE_PASSWORD) { console.error("Set QUICKVEE_STORE_NAME, QUICKVEE_USERNAME and QUICKVEE_PASSWORD (e.g. --env-file=.env.local)."); process.exit(2); }
try {
  const { csv, orders } = await scrapeOrderHistory(config, { ...args, log: (l, m) => (l === "info" ? console.log : console.warn)(m) });
  writeFileSync(args.out, csv);
  console.log(`Wrote ${orders.length} orders (${orders.reduce((n, o) => n + o.items.length, 0)} line items) to ${args.out}. Upload it in Data sync → Manually add → Order history.`);
} catch (e) {
  console.error(e instanceof MfaRequiredError ? `${e.message}\nRun again with --headed, finish MFA in the browser; the session is saved for next time.` : (e as Error).message);
  process.exit(1);
}
