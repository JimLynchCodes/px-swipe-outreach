import { loadConfigOrExit } from "../config.js";
import { MfaRequiredError, OrderCsvWriter, parseScrapeArgs, scrapeOrderHistory } from "./scrape.js";

const USAGE = "Usage: npm run scrape:quickvee:orders -- --from YYYY-MM-DD --to YYYY-MM-DD --out orders.csv [--channel in-store|online|both] [--limit N] [--resume] [--details] [--headed] [--tz America/New_York]";
let args;
try { args = parseScrapeArgs(process.argv.slice(2)); } catch (e) { console.error(`${(e as Error).message}\n${USAGE}`); process.exit(2); }
const config = loadConfigOrExit();
if (!config.QUICKVEE_STORE_NAME || !config.QUICKVEE_USERNAME || !config.QUICKVEE_PASSWORD) { console.error("Set QUICKVEE_STORE_NAME, QUICKVEE_USERNAME and QUICKVEE_PASSWORD (e.g. --env-file=.env.local)."); process.exit(2); }

const writer = new OrderCsvWriter(args.out, args.resume, undefined, args.tz);
let to = args.to;
if (args.resume && writer.seen.size) {
  // The list is newest first, so everything newer than the oldest saved order is done: continue from that day.
  if (writer.oldestDay && writer.oldestDay < to) to = writer.oldestDay;
  console.error(`Resuming: ${writer.seen.size} orders already in ${writer.files.join(", ")}; continuing from ${to} back to ${args.from}`);
}
let written = 0;
try {
  await scrapeOrderHistory(config, {
    ...args, to, seen: new Set(writer.seen), limit: args.limit,
    onOrders: batch => { writer.write(batch); written += batch.length; },
    log: (l, m) => console.error(l === "info" ? m : `${l.toUpperCase()}: ${m}`)
  });
  console.log(`Wrote ${written} new orders (${writer.seen.size} total) to ${writer.files.join(", ")}. Upload ${writer.files.length > 1 ? "each file" : "it"} in Data sync → Manually add → Order history.`);
} catch (e) {
  console.error(e instanceof MfaRequiredError ? `${e.message}\nRun again with --headed, finish MFA in the browser; the session is saved for next time.` : (e as Error).message);
  console.error(`${written} orders were saved to ${writer.files.join(", ")}; re-run with --resume to continue.`);
  process.exit(1);
}
