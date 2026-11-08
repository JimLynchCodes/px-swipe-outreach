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
- **Login selectors.** Each field is found by its label ("Store name", "Username", "Password"), then its placeholder, then its `name`/`id` (`QV.login` in `src/sync/quickvee/selectors.ts`). Small markup changes therefore don't break the login.
- **Session.** Cookies persist in `QUICKVEE_STATE_DIR/session.json` (default `.quickvee/`, gitignored and dockerignored). The Docker image uses `/app/.quickvee`; mount a volume there.
- **MFA.** A headless run stops with a clear error. Run once headed (below), complete MFA in the browser, and the session is saved.
- **Polite.** At most one navigation per `QUICKVEE_MIN_DELAY_MS` (1500 ms). Orders go in `QUICKVEE_CHUNK_DAYS` windows (7).
- **CSV first, crawl fallback.** If the page has an export control, the job downloads the CSV. Otherwise it crawls the table, follows pagination, and opens each order's detail page for line items. Header aliases cover common export column names (`src/sync/quickvee/selectors.ts` → `CSV_ALIASES`).
- **Raw snapshots.** CSVs are kept in `QUICKVEE_STATE_DIR/raw/` (PII, gitignored). Set `QUICKVEE_SAVE_RAW=false` to skip them.
- **Normalization.** Phones go to E.164 (US) and emails to lowercase. Portal dates are store-local and converted with the store timezone. Customers are matched by external id (`qv:<id>`), then phone (last 10 digits), then email. Walk-in orders with no contact are skipped and counted in the log. After orders load, each touched customer's profile is recomputed from real history: lifetime spend, last purchase, AOV, visits/month (last 90 days), typical weekday and time of day, and top categories and brands.

### Calibrating Quickvee selectors (first run, headed)

The real portal's markup isn't documented. Every selector and path lives in `src/sync/quickvee/selectors.ts`, and the mock portal (`test/fixtures/quickveePortal.ts`) implements exactly those. To calibrate:

1. On a machine with a display: `cd retail-outreach-backend && QUICKVEE_HEADLESS=false QUICKVEE_MIN_DELAY_MS=3000 npm run sync -- quickvee-rewards --dry-run` (with `QUICKVEE_STORE_NAME`/`QUICKVEE_USERNAME`/`QUICKVEE_PASSWORD`/`QUICKVEE_BASE_URL` in your env file).
2. Watch the login. If it stalls, inspect the page (DevTools) and update `QV.login.*`, `QV.loggedIn` and `QV.paths.*`. Complete MFA if asked; the session is then saved.
3. On the rewards and orders pages, check that `QV.exportCsv` matches the export button. If there's no export, set the table, row and `data-col` cell selectors and `QV.nextPage`.
4. Re-run with `--dry-run` until the run log shows the expected row counts, then update the mock portal to match and run `npm test`.

Try the scraper locally against the mock: `npm run quickvee:mock` (http://localhost:4799, `demo@store.test` / `correct-horse`; `MFA=1` and `CSV=0` switch modes), then point `QUICKVEE_BASE_URL` at it.

### Order history to CSV (`scrape:quickvee:orders`)

`npm run scrape:quickvee:orders -- --from 2026-01-01 --to 2026-11-07 --out orders.csv` (run from `retail-outreach-backend`):

- It logs into Quickvee with the same Playwright scraper as the `quickvee-orders` sync job: CSV export first, table crawl fallback, saved session, MFA stop, rate limit, and `QUICKVEE_CHUNK_DAYS` windows.
- It writes the order history to a CSV in exactly the format **Data sync → Manually add (order history)** accepts. Nothing is written to the database; upload the file to import it.
- Flags:
  - `--from` defaults to 30 days before `--to`
  - `--to` defaults to today
  - `--out` defaults to `quickvee-orders-<from>_<to>.csv`
  - `--tz` is the store timezone for portal dates (default `America/New_York`)
  - `--headed` shows the browser
- Credentials come from the environment, e.g. `npx tsx --env-file=.env.local src/orders/scrapeCli.ts …`, or put `QUICKVEE_STORE_NAME`, `QUICKVEE_USERNAME`, `QUICKVEE_PASSWORD` and `QUICKVEE_BASE_URL` in your shell.
- **First run on the real portal (headed calibration):**
  1. Run `npm run scrape:quickvee:orders -- --from 2026-11-01 --to 2026-11-07 --out test.csv --headed` with `QUICKVEE_MIN_DELAY_MS=3000` on a machine with a display.
  2. Complete MFA if asked; the session is saved in `QUICKVEE_STATE_DIR`.
  3. If login or the orders page stalls, fix `src/sync/quickvee/selectors.ts` as described in *Calibrating Quickvee selectors* above.
  4. Repeat until `test.csv` has the expected orders.
  5. Later runs can be headless.
- **Try it against the mock:** run `npm run quickvee:mock`, then `QUICKVEE_BASE_URL=http://localhost:4799 QUICKVEE_STORE_NAME=cloud9-qv-store QUICKVEE_USERNAME=qv-user-7731 QUICKVEE_PASSWORD=correct-horse npm run scrape:quickvee:orders -- --from 2026-09-01 --to 2026-11-07 --out orders.csv`. `test/scrape-orders.test.ts` covers both the CSV export and crawl modes, checks the output is accepted by the import, and runs the CLI.
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
