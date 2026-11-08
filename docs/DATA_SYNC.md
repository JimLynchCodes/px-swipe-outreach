# Data sync

Data sync pulls outside data into Outreach's Supabase Postgres. It's part of the backend, in `retail-outreach-backend/src/sync/`, not a separate service. Owners and admins manage it from the hamburger menu under **Data sync**.

| Source (job id) | What it loads | Needs (server env) |
| --- | --- | --- |
| AI usage (`ai-usage`) | Provider-reported usage and cost per day and model, from **OpenRouter** (`/api/v1/activity`, `/api/v1/credits`) and **OpenAI** (Usage + Costs APIs). Keyed by provider and reconciled against what the app recorded in `ai_usage`. → `provider_usage_daily` | `OPENROUTER_API_KEY` (or `OPENROUTER_PROVISIONING_KEY`; `/activity` needs a provisioning key) and/or `OPENAI_ADMIN_KEY` |
| Twilio (`twilio`) | Daily SMS usage records → `twilio_usage_daily`. Each outbound message's actual price, segments and status are backfilled into the send ledger `sms_costs` (by SID). | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` |
| Email tracking (`email`) | Every sent email gets an `email_tracking` row: message id (or `delivery:<id>` if the provider gave none, which is flagged in the log), status, and bounces. The source is the send ledger; there's a provider interface for event APIs, with SendGrid's included. | none (`EMAIL_EVENTS_PROVIDER=sendgrid` + `SENDGRID_API_KEY` adds SendGrid) |
| Quickvee rewards (`quickvee-rewards`) | Rewards members: name, phone, email, points, signup date. Matched to customers by phone or email; new customers are created otherwise. | `QUICKVEE_EMAIL`, `QUICKVEE_PASSWORD` |
| Quickvee orders (`quickvee-orders`) | Orders: id, date, customer, line items with category and brand, totals, discounts and payment. Loaded into `purchases` / `purchase_items`. Recent orders run on schedule; **Backfill history** pages through any date range. | same |

## How a run works

- **Background job and lock.** **Force re-sync**, a schedule or the CLI calls `SyncRunner.start`. It claims a lock: a unique index allows one `running` row per org and job in `etl_runs`. If the job is already running you get `409 already_running`, and the UI says so. If a run's heartbeat goes quiet (the process died), it's marked failed on the next claim, after 10 minutes.
- **Progress and log.** Phase, done/total, rows read and written, and log lines (capped at 500) are written to the run row about every second. The page polls `/api/sync` every 2s while anything is running. Expanding a run in **Run history** shows its log.
- **Idempotent.** Every write is an upsert on a natural key: (provider, day, model), (day, category), message SID, message id, or `qv:<order id>`. Re-running a window updates rows; it never duplicates them. Order line items are replaced as a set.
- **Watermarks** (`etl_watermarks`). Each job resumes from its watermark and re-reads a little overlap, because providers finalize data late:
  - ai-usage: 2 days
  - twilio: 1 day
  - email: 1 hour
  - quickvee-orders: 1 day, advanced per window, so a failed run resumes where it stopped

  Backfills never move the watermark.
- **Retries.** HTTP calls retry 408, 429 and 5xx responses with exponential backoff plus jitter, honoring `Retry-After`. Other 4xx errors fail fast. Response bodies are never logged.
- **Structured logs.** Lines go to the run log and to the server log (pino) with `job` and `runId`. Values of secret env vars and `Bearer`/`Basic` tokens are redacted from every line and error.
- **Dry run.** `--dry-run` (CLI) or `{ "dryRun": true }` (API) reads everything and counts what it would write, but writes nothing and leaves watermarks alone.

## Scheduling

Each source has a **frequency** (Off, Daily, Weekly, Monthly or Yearly), a **start date** and a **time** (to the second), e.g. 10:00:00 AM on 11/15/2026. Times are in the **store timezone** (the selector at the top of the page; stored in `org_settings.timezone`, default `America/New_York`).

- Runs happen at start + n × interval on the local calendar, so 10:00 stays 10:00 across DST.
- Monthly and yearly runs clamp to the last day of shorter months: Jan 31 → Feb 28/29 → Mar 31, and Feb 29 → Feb 28 in non-leap years. The cadence doesn't drift.
- A time skipped by spring-forward (02:30) runs at 03:30. An ambiguous fall-back time runs at its first occurrence.
- **Scheduler loop.** It runs in the API process (`SYNC_SCHEDULER=true`, every `SYNC_SCHEDULER_INTERVAL_SECONDS`, default 60). Each tick claims due rows with `SELECT … FOR UPDATE SKIP LOCKED` and sets `next_run_at` to the first slot **after now**. With several instances, exactly one gets each due job. After downtime, a missed job runs **once**, not once per missed slot. Scheduled runs also take the run lock, so they never overlap a manual run.
- Schedules for unconfigured sources are skipped (logged).

Alternatives if you'd rather not run the loop in the API: set `SYNC_SCHEDULER=false` and use a platform cron that calls the CLI, e.g. `node dist/sync/cli.js all` on Render or Fly cron, or Kubernetes CronJobs. The CLI uses the same lock and run log.

## CLI (dev)

```bash
cd retail-outreach-backend
npm run sync -- <ai-usage|twilio|email|quickvee-rewards|quickvee-orders|all> [--org <uuid>] [--dry-run] [--from YYYY-MM-DD --to YYYY-MM-DD]
npm run sync:all                      # every configured job; skips ones missing env vars
npm run sync:quickvee:orders -- --from 2023-01-01 --to 2023-12-31   # deep backfill
# Against Supabase: tsx --env-file=.env.supabase.local src/sync/cli.ts twilio --org <org uuid>
```

`--org` defaults to `SYNC_ORG_ID`, then the demo org. Exit code 1 if any job failed.

## Quickvee (Playwright)

**Scrape only with the merchant's own Quickvee account.**

- **Credentials.** The Quickvee login page has three fields, which map to `QUICKVEE_STORE_NAME`, `QUICKVEE_USERNAME` and `QUICKVEE_PASSWORD`. They come from the environment only and are never logged (they're redacted even if a page echoes them). The Data sync page shows **Not configured** and lists whichever names are missing until all three are set. `QUICKVEE_EMAIL` still works as a deprecated alias for `QUICKVEE_USERNAME`.
- **Login.** No label matching: the first visible text input on the login page gets the store name, the second visible text/email input gets the username, and the first password input gets the password. Then it clicks the submit button (or presses Enter).
- **Session.** Cookies persist in `QUICKVEE_STATE_DIR/session.json` (default `.quickvee/`, gitignored and dockerignored). The Docker image uses `/app/.quickvee`; mount a volume there.
- **MFA.** A headless run stops with a clear error. Run once headed (below), complete MFA in the browser, and the session is saved.
- **Polite.** At most one navigation per `QUICKVEE_MIN_DELAY_MS` (1500 ms). The scheduled orders sync goes in `QUICKVEE_CHUNK_DAYS` windows (7); the CLI uses the portal's 1-year maximum.
- **Login page:** `https://quickvee.com/merchants/login` (`QV.paths.login`, default base `https://quickvee.com`); orders live at `/merchants/order-new`.
- **Rewards: CSV first, crawl fallback.** If the rewards page has an export control, the job downloads the CSV; otherwise it crawls the table and follows pagination.
- **Orders: the Orders Management crawler** (`src/sync/quickvee/orderCrawler.ts`), used by both the `quickvee-orders` job and `scrape:quickvee:orders`. There's no usable export, so it:
  1. opens `https://quickvee.com/merchants/order-new` and clicks the **In-Store** tab (or **Online**; `QUICKVEE_ORDER_CHANNEL` / `--channel`, `both` does In-Store then Online);
  2. types the range into **Start Date** / **End Date** (`MM/DD/YYYY`), falling back to setting the input value with change events if typing doesn't stick; ranges over 1 year are split;
  3. waits for the list to refresh and reads the expected count from "Showing N orders";
  4. scrolls the infinite list (window and any scrollable container) until it has N blocks, or nothing new loads for `QUICKVEE_STALL_SECONDS` (30s; logs a warning when short of N);
  5. clicks **Show Items** on each block and reads order ID, date/time, customer (Walk-In Customer = no customer), total, payment, the Refunded badge and line items (name, qty, price);
  6. also reads any JSON responses the page loads that contain order-like objects (matched by order ID) for phone, email, SKU, category and brand. The first 3 bodies are saved to `QUICKVEE_STATE_DIR/raw/` for calibration.
  Orders are de-duplicated by order ID. `QUICKVEE_ORDER_LIMIT` (scheduled sync) / `--limit` (CLI) stop after N orders; the default is all. A run cut short by the limit doesn't advance the incremental watermark.
- Header aliases for CSV imports cover common export column names (`src/sync/quickvee/selectors.ts` → `CSV_ALIASES`).
- **Raw snapshots.** CSVs are kept in `QUICKVEE_STATE_DIR/raw/` (PII, gitignored). Set `QUICKVEE_SAVE_RAW=false` to skip them.
- **Normalization.** Phones go to E.164 (US) and emails to lowercase. Portal dates are store-local and converted with the store timezone. Customers are matched by external id (`qv:<id>`), then phone (last 10 digits), then email. Walk-in orders with no contact are skipped and counted in the log. After orders load, each touched customer's profile is recomputed from real history: lifetime spend, last purchase, AOV, visits/month (last 90 days), typical weekday and time of day, and top categories and brands.

### Calibrating Quickvee selectors (first run, headed)

The real portal's markup isn't documented. Every selector and path lives in `src/sync/quickvee/selectors.ts`, and the mock portal (`test/fixtures/quickveePortal.ts`) implements exactly those. To calibrate:

1. On a machine with a display: `cd retail-outreach-backend && QUICKVEE_HEADLESS=false QUICKVEE_MIN_DELAY_MS=3000 npm run sync -- quickvee-rewards --dry-run` (with `QUICKVEE_STORE_NAME`/`QUICKVEE_USERNAME`/`QUICKVEE_PASSWORD`/`QUICKVEE_BASE_URL` in your env file).
2. Watch the login. If it stalls, inspect the page (DevTools) and check `QV.loggedIn`, `QV.loggedInText` and `QV.paths.*` (the login itself is by input position). Complete MFA if asked; the session is then saved.
3. On the rewards page, check `QV.exportCsv` (or the table selectors and `QV.nextPage`). On Orders Management, check `QV.ordersPage`: the tab names, the Start/End Date inputs, the "Showing N orders" text, the order-ID pattern, and the Show Items / View Details button text. Order blocks are found by content (an order-ID line plus a View Details button), not by class names. Look at `QUICKVEE_STATE_DIR/raw/orders-api-*.json` to see what the list API returns.
4. Re-run with `--dry-run` until the run log shows the expected row counts, then update the mock portal to match and run `npm test`.

Try the scraper locally against the mock: `npm run quickvee:mock` (http://localhost:4799, store `cloud9-qv-store`, `qv-user-7731` / `correct-horse`; `MFA=1` and `CSV=0` switch modes), then point `QUICKVEE_BASE_URL` at it. The mock mirrors Orders Management at `/merchants/order-new` (tabs, date inputs, infinite scroll, Show Items, View Details).

### Order history to CSV (`scrape:quickvee:orders`)

```bash
cd retail-outreach-backend
npx tsx --env-file=.env.local src/orders/scrapeCli.ts --from 2026-01-01 --to 2026-10-31 --out orders.csv --headed
# same thing via npm, with the QUICKVEE_* vars in .env: npm run scrape:quickvee:orders -- --from 2026-01-01 --to 2026-10-31 --out orders.csv
```

- Logs in (saved session, MFA stop) and runs the Orders Management crawler above, newest first.
- Writes a CSV in exactly the format **Data sync → Manually add → Order history** accepts: one row per line item (one row when an order has no items), plus a `Status` column (`Refunded`). Nothing goes to the database; upload the file.
- **Writes as it goes.** If it crashes, re-run the same command with `--resume`: orders already in the file are skipped and the crawl restarts from the oldest saved day. Files roll over to `orders.part2.csv`, `orders.part3.csv`, … before the import's 50,000-row upload limit; upload each.
- Progress goes to stderr; the summary to stdout.
- Flags:
  - `--from` / `--to`: `YYYY-MM-DD`, default `2026-01-01` → `2026-10-31`
  - `--out`: default `quickvee-orders-<from>_<to>.csv`
  - `--channel in-store|online|both`: default `in-store`
  - `--limit N`: stop after N orders (default: all). Handy for a first test run: `--limit 1000`
  - `--resume`: continue an interrupted run
  - `--details`: open **View Details** for each named customer to read phone/email (slow, one click per order; skip it for 21k orders unless needed)
  - `--headed`: show the browser
  - `--tz`: store timezone for portal dates (default `America/New_York`)
- Rate limit: one navigation/scroll step per `QUICKVEE_MIN_DELAY_MS` (1500 ms). 21,000 orders take a while; use `--limit` for a trial first.
- **First run on the real portal:** run with `--headed --limit 50` and watch it. If the date inputs, tab or blocks aren't found, it stops with a message naming the field; adjust `QV.ordersPage` in `src/sync/quickvee/selectors.ts`.
- **Try it against the mock:** `npm run quickvee:mock`, then `QUICKVEE_BASE_URL=http://localhost:4799 QUICKVEE_STORE_NAME=cloud9-qv-store QUICKVEE_USERNAME=qv-user-7731 QUICKVEE_PASSWORD=correct-horse npm run scrape:quickvee:orders -- --from 2026-09-01 --to 2026-11-07 --out orders.csv`. `test/scrape-orders.test.ts` covers JSON and DOM-only list modes, both channels, `--limit`, `--resume`, file rollover and the CLI.
- The output contains customer PII. Keep it out of git (`*.csv` in the backend is gitignored except test fixtures).

### Runtime

- Playwright runs through `playwright-core` with a system Chromium. There's no browser download.
- The Docker image installs Alpine's `chromium` and sets `QUICKVEE_CHROMIUM_PATH=/usr/bin/chromium-browser`.
- Locally, the path is auto-detected (`/usr/bin/chromium*`, `google-chrome`); set `QUICKVEE_CHROMIUM_PATH` otherwise, or `npx playwright install chromium` and point at it.
- CI uses the runner's Google Chrome.

## Suggestions use the synced data

- **Rewards** (`customers.rewards_member/points/joined_at`) flow into the card's customer.
  - The rules engine adds "Rewards member with N points" to its reasons and quotes the real balance in copy when it fits.
  - The AI prompt gets `rewards` and may quote the balance **exactly**. The validator rejects copy whose points don't match the real balance, or that mentions points for a non-member (`invented_points`).
- **Purchase history** (`src/insights.ts`): order frequency, recency, AOV, top categories and brands by items bought, and **repurchase-cycle prediction** for consumables (median gap between purchases of the same item).
  - A deal that covers a restock that's due gets a boost and a reason ("Restock due: buys Geek Bar Pulse about every 7 days (due in 1 day)").
  - The AI prompt gets `restock_due` for a light "time to stock up?" angle.

## Data model and security

The migration `supabase/migrations/20261108100000_data_sync.sql` adds:

- `sync_schedules`, `etl_runs`, `etl_watermarks`, `provider_usage_daily`, `twilio_usage_daily` and `email_tracking`, all with RLS: owners and admins can read; only they can insert or update schedules; nobody else sees anything.
- `org_settings.timezone`.
- Rewards columns on `customers`; discount, payment and source on `purchases`; category, brand and discount on `purchase_items`.

Jobs write through the backend's privileged database connection (the same one the delivery worker uses). The service role key and every provider credential stay on the server and are never sent to the browser. The API returns only the **names** of missing env vars.

## API (owners/admins)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/sync` | timezone, scheduler flag, one entry per source (configured, missing env names, schedule, last run) |
| PUT | `/api/sync/timezone` | `{ timezone }` (IANA). Recomputes every schedule's next run. |
| PUT | `/api/sync/:job/schedule` | `{ frequency, startLocal: "2026-11-15T10:00:00" }` |
| POST | `/api/sync/:job/run` | `{ dryRun?, from?, to? }` → `202 { run }`. `from`/`to` only for quickvee-orders (backfill). `409 already_running`, `422 not_configured`. |
| GET | `/api/sync/runs?job=&limit=` | history, without logs |
| GET | `/api/sync/runs/:id` | one run with its log |

## What's verified

- **Tested:**
  - schedule math: DST, month-end, leap years, catch-up
  - runner: lock, stale reaping, dry run, redaction, retries
  - scheduler
  - each job against faked provider APIs
  - the Postgres repo against a real Postgres: concurrent claim locking, SKIP LOCKED, upserts, profile refresh, RLS
  - the Quickvee scraper with real Chromium against the mock portal: CSV, crawl, session reuse, MFA stop, bad login
  - the API and the Data sync page
- **Not verified live:** OpenAI, OpenRouter, Twilio, SendGrid and Quickvee need real credentials. Quickvee selectors also need the one-time calibration above.
