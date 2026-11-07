# Smoke-shop outreach: promotions, settings, opt-outs and replies

This covers how the deck chooses an offer, what Settings controls, and how opt-outs and two-way replies work.
For the API and environment variables, see [retail-outreach-backend/README.md](../retail-outreach-backend/README.md).

## Customers and buying patterns

Each customer has a **buying profile**:

* favorite categories (vape, CBD, glass, papers, cigars, hookah, accessories) and brands
* visits per month and average basket
* the day and time of day they usually shop

The **segment** comes from days since the last visit compared with their usual interval (`30 / visitsPerMonth`):

| Segment | Rule |
| --- | --- |
| Lapsed | days ≥ max(60, 3 × interval) |
| At risk | days ≥ max(21, 1.75 × interval) |
| Loyal | everyone else |

The demo seed (`src/data/seed.ts`, and `npm run db:seed` for Postgres) has 20 customers covering every segment. It also includes:

* one customer whose age isn't verified (Ryan)
* one customer with no phone (Elena)
* seasonal promotions dated relative to today: Holiday Season Glass (Nov 20 – Dec 31), Black Friday Weekend (Fri–Sun after Thanksgiving), 4/20 Week (Apr 16–22) and a disabled month-long vape special
* three seed opt-outs
* a few reply threads, some of them unread

## Promotions model (one entity, two views)

**Promotions and weekly deals are the same thing.** Each row in `deals` is a reusable promotion with:

* `title`, `description`
* `discountType` (`percent` / `amount` in cents / `bogo` / `freebie`) and `discountValue`
* `categories` and/or `productIds` it targets
* `schedule`: `weekly` (runs on `days`) or `range` (a **seasonal or ongoing** promotion that runs every day from `startsOn` to `endsOn`; both dates are required and `days` is stored as all seven)
* `days`: one to seven weekdays (0 = Monday … 6 = Sunday)
* `startsOn` / `endsOn`: an optional date window
* `active`: the **Enable** checkbox

There are two views of that data:

* **Deals this week** (the side panel next to the deck) lists *enabled* promotions in the Mon–Sun slot for each of their days.
  * **+** on a day creates a promotion for that day.
  * **×** removes the promotion from that day only. On a single-day promotion, it deletes it.
* **Seasonal & ongoing deals** (under the weekly slots) lists date-range promotions such as the holiday season, Black Friday weekend, 4/20 week or a month-long special. Each shows its title, date range, a "Starts in N days" / "N days left" / "Last day" label, its discount and whether it's enabled. Ended ones are hidden there but stay in Settings. Owners and admins can add, edit and delete them.
* **Manage promotions** (bottom of the panel) opens `/settings#promotions` and scrolls to that section.
* **Settings → Promotions** lists every promotion, enabled or not. Use it to add, edit and delete them, or to pause one by unticking its checkbox.

The **suggestion engine** (`src/recommend.ts`) only considers a promotion when all of these hold:

* it is `active`
* it runs on the next occurrence of one of its `days` within `startsOn`…`endsOn`
* a percent discount isn't above the store's **max discount**

Weekly and date-range promotions compete on the same score. A running seasonal promotion adds the reason "Seasonal promotion, runs every day through …", plus a small boost in its last week.

Matching promotions are scored on:

* category, brand and product match with the customer's favorites
* whether the deal falls on the customer's usual shopping day
* how soon the deal day is
* segment (lapsed customers favor bigger discounts)

The best one is passed to the rules or OpenAI copywriter. The card shows:

* the **deal chip** (which promotion, discount and day)
* the **reasons** it was chosen
* the best time to send. Morning shoppers get the message the evening before.

Any change to promotions in the side panel re-runs the suggestion for the current card.

## AI model picker

The **Using model … ▾** pill in the header (it replaced "AI Powered") picks the model that writes suggestions. The choice is stored per org in `org_settings.ai_model`.

* **Who can change it:** owners and admins. Staff see the list read-only.
* **Validation:** the API checks the choice against the allowlist in `src/ai/models.ts`.
* **Effect:** changing the model re-runs the current card's suggestion.

| Model | $ / 1M input | $ / 1M output | Notes |
| --- | --- | --- | --- |
| **GPT-4o mini** (default) | 0.15 | 0.60 | Cheapest capable chat model on OpenAI's price list (checked Nov 2026) |
| GPT-5.4 nano | 0.20 | 1.25 | Reasoning model; no custom temperature |
| GPT-5 mini | 0.25 | 2.00 | Reasoning model |
| GPT-4.1 mini | 0.40 | 1.60 | |
| GPT-5.4 mini | 0.75 | 4.50 | Reasoning model |
| None | – | – | Heuristic-based canned suggestions, free |

Prices live in a versioned table (`PRICE_TABLE_VERSION`). Update it when OpenAI changes prices. GPT-5 nano and GPT-4.1 nano were cheaper, but OpenAI lists them as deprecated or shut down.

**Without `OPENAI_API_KEY`,** OpenAI models show as *Unavailable* with a note, and suggestions use rules. The pill reads "(rules fallback)". Provider errors also fall back to rules.

**Adding a provider** (e.g. Anthropic):

1. Add it to `PROVIDERS` and its models to `MODELS` in `src/ai/models.ts`.
2. Implement a `SuggestionProvider`.
3. Register it in `createSuggestionProvider` when its key is set.

Providers without a key are never registered.

## Settings (per org)

These are stored in `org_settings` (RLS: members read, owners and admins write) or in memory in demo mode.

| Setting | Effect |
| --- | --- |
| Store name | Used in generated copy and the email footer |
| Default channel | Channel each card opens on (falls back to the customer's preference or whatever is reachable) |
| Max discount (%) | Promotions and fallback offers above this are never suggested |
| Email signature | Multiline. Added to generated emails and to email replies |
| Text signature | ≤ 60 chars, one line. Added to texts and replies. **Counts toward the 480-char SMS limit** |

## Compliance

* **21+ only.** Customers who aren't age-verified (or are under 21) can't be contacted. The card shows a notice and Send is disabled. The server enforces this too.
* Every marketing **SMS ends with "Reply STOP to opt out."** The server adds it on send if an edited message dropped it.
* Every **email** carries a footer, a unique **unsubscribe link**, and RFC 8058 `List-Unsubscribe` / `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers.
* The OpenAI prompt forbids health claims and youth appeal. The rules copy says "21+ w/ ID".

## Opt-outs (per channel)

Suppressions are stored **per channel and contact**. A text STOP blocks texts only, and an email unsubscribe blocks email only.

These all check suppressions for the specific channel:

* deck sends
* the queue worker
* replies
* card reachability

Each entry records its **source**: `sms_stop`, `email_unsubscribe`, `manual` (the "Customer opted out?" link on a card) or `provider`. Every change writes an audit event.

**Menu → Opt-out list** shows the list:

* customer name, masked contact, channel, date and source
* a channel filter, search by name or contact, and pagination (20 per page)

### Twilio inbound SMS

1. In Twilio, set your Messaging Service or number's **"A message comes in"** webhook (HTTP POST) to:

   ```
   ${PUBLIC_API_URL}/webhooks/twilio/sms/<orgId>
   ```

2. Set `TWILIO_AUTH_TOKEN`. Requests are then verified with `X-Twilio-Signature`, computed over `PUBLIC_API_URL + path`. A bad signature returns 403. In production, the webhook returns 503 if no token is set.

Keyword handling (case-insensitive, trimmed):

* **STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT** opt the number out and reply with a confirmation.
* **START, UNSTOP** re-subscribe it.
* **HELP** replies with the store name and opt-out instructions.

Replies are TwiML. Repeats are idempotent. Every inbound text is stored in the customer's thread, and keyword messages are labelled "opted out" or "re-subscribed".

> Twilio's Advanced Opt-Out may also handle these keywords at the carrier level. Leave it on: our handler keeps the app's own list in sync.

### Email unsubscribe

Each email gets the link `${PUBLIC_API_URL}/unsubscribe?t=<id>.<HMAC-SHA256>`, signed with `UNSUBSCRIBE_SIGNING_SECRET`.

* **GET** shows a confirm page and never opts anyone out, so link scanners can't trigger it.
* **POST** opts the address out. Mail clients' one-click POST does the same.

The pages are idempotent, rate-limited (30/min per IP), carry a strict CSP and contain **no PII**. Production refuses to start without a ≥ 32-char secret and an https `PUBLIC_API_URL`.

## Re-opt-in and consent history

Only the customer can lift an opt-out. Signed-in users (staff, admins **and** owners) can't delete suppressions: the API has no endpoint for it, and RLS revokes `delete` on `suppressions`.

There are three ways back in:

* **Email "Changed your mind?"** The unsubscribe confirmation page has a **Resubscribe** button. It POSTs to `/resubscribe?t=<id>.<HMAC>`, which is signed for that purpose only, so an unsubscribe token can't be replayed. It is POST-only (no GET handler, so link scanners can't trigger it), idempotent, rate-limited (30/min per IP) and shows no PII.
* **SMS START / UNSTOP / JOIN.** These re-subscribe the number, reply with a confirmation and are logged in the thread.
* **Re-opt-in request** (owners and admins, on the Opt-out list). This asks the customer once whether they want to hear from the store again:
  * **Email:** one message with a signed `/reopt-in?t=…` link. GET shows a confirm page and POST resubscribes. The link expires after 30 days.
  * **SMS:** one text: "Reply START to resubscribe. No reply = no more texts." This is **off by default**. Texting a number that replied STOP is restricted under CTIA guidance and the TCPA, so the API returns `403 sms_reoptin_disabled` unless `ALLOW_SMS_REOPTIN_REQUEST=true`. Turn it on only after a compliance review.
  * Limits: one request per customer per channel per **30 days**, and never while a request is pending (`409 reoptin_pending` / `429 reoptin_cooldown`). The database also enforces at most one pending request per contact.
  * If the provider fails to send, the request is cancelled so it can be retried.
  * A START reply or a link click marks the request confirmed.
  * Bounced or complained contacts can't be asked.

**Consent history.** Every opt-out, opt-in and re-opt-in request is written to `consent_events` with:

* channel and contact
* event and source (`sms_stop`, `sms_start`, `email_unsubscribe`, `email_resubscribe`, `reoptin_link`, `store_request`, `manual`, `provider`)
* timestamp
* the acting team member, or the request ID (the Twilio MessageSid for texts)

The table is append-only: a trigger blocks updates and deletes, except when the organization itself is deleted. Expand a row on the Opt-out list to see its history. Resubscribed customers drop off the list.

## Replies (two-way inbox)

**Menu → Replies** works like iPhone Messages:

* The conversation list shows initials, name, preview, relative time, a channel icon and an unread dot, most recent first.
* The thread view shows outbound bubbles on the right and inbound on the left, with timestamps.

The hamburger icon and the menu item show the **unread count**. The list, the thread and the badge **poll every 15 s** while the tab is visible.

The composer replies **on the thread's channel**:

* It adds the signature and shows the SMS character count.
* It's replaced by a notice when the customer opted out of that channel. The server also returns 422.

Opening a thread marks it read.

Storage and matching:

* `conversations` (one per org, channel and normalized contact) and `messages` (RLS: org members read; staff can insert outbound messages only as themselves).
* Every deck send is recorded in the customer's thread.
* Inbound SMS arrives through the Twilio webhook above.
* Inbound email is matched by a per-message **Reply-To token**: outbound mail uses `Reply-To: reply+<token>@INBOUND_EMAIL_DOMAIN`.

### Inbound email (SendGrid Inbound Parse or similar)

1. Point an MX record for `INBOUND_EMAIL_DOMAIN` (e.g. `reply.yourstore.com`) at your inbound provider (SendGrid: `mx.sendgrid.net`).
2. Set the Parse webhook URL to:

   ```
   ${PUBLIC_API_URL}/webhooks/email/inbound?key=<INBOUND_EMAIL_SECRET>
   ```

   You can send the secret in an `X-Inbound-Secret` header instead.

The endpoint accepts multipart (SendGrid's default), urlencoded or JSON. Attachments are discarded and quoted text is stripped. The sender must match the thread's address, so a spoofed or forwarded reply is ignored. Without `INBOUND_EMAIL_SECRET` the endpoint returns 503.

## Cost metrics (☰ → Cost metrics at `/cost-metrics`, owners/admins)

Its own page, listed in the menu directly under Performance metrics. It used to live under Settings; the old `/settings/costs` URL now redirects to `/cost-metrics`.

Every suggestion call writes one `ai_usage` row: org, opportunity, actor, model, provider, input/output tokens (from the
API response's `usage`), `cost_usd` priced at call time from the versioned table in `retail-outreach-backend/src/ai/models.ts`
(`PRICE_TABLE_VERSION`; changing prices never rewrites history), the featured deal, and whether it led to a send
(`led_to_send`, `sent_channel`). "None" (rules) calls are recorded with 0 tokens and $0.

Each send also writes an `outreach_sends` ledger row (who sent, channel, deal + its categories/products, and the model
that wrote the suggestion), so messages sent are counted per model.

`GET /api/metrics/costs` returns the year to date: total spend, messages sent, AI calls, a per-model breakdown, then
months newest first with per-model rows (messages sent, AI calls, tokens in/out, spend) and a month total. USD shows
sub-cent precision (`$0.000585`). Staff get 403; RLS only lets owners/admins select `ai_usage`, and members mark a call as
sent through the narrow `mark_ai_usage_sent()` definer function.

### Twilio spend

Every outbound SMS writes one `sms_costs` row (migration `20261107240000_sms_costs.sql`). This covers deck sends, replies and re-opt-in texts. Each row has the provider, the Twilio message SID, the segment count, `price_usd` (positive USD), `estimated` and `status`.

| When | Price stored |
|---|---|
| `SMS_PROVIDER=log` | $0, never estimated (nothing is sent) |
| Twilio returns a price at send (rare) | Twilio's price |
| Otherwise | segments × `TWILIO_SMS_PRICE_ESTIMATE`, flagged `estimated` |

The estimate defaults to **$0.0125 per segment**. Twilio's US page (October 2026) lists $0.0083 per outbound segment *plus* a carrier fee of $0.0035 (AT&T) to $0.0050 (Verizon), or $0.0042 for other carriers. $0.0083 on its own would undercount by about a third.

The actual price replaces the estimate in two ways:
1. **StatusCallback.** Each Twilio send sets `StatusCallback = <PUBLIC_API_URL>/webhooks/twilio/status/<orgId>`, but only when `PUBLIC_API_URL` isn't localhost. `X-Twilio-Signature` is verified against that public URL. Callbacks don't carry the price, so on a final status (`sent`, `delivered`, `undelivered`, `failed`) the backend fetches the message and stores `|price|` when `price_unit` is USD.
2. **Reconcile job.** The API server runs this every `TWILIO_RECONCILE_MINUTES` (default 10; 0 = off). It fetches messages still on an estimate that are 2 minutes to 30 days old, which covers missed callbacks and messages Twilio hasn't priced yet.

**Number fee (decision):** off by default. Set `TWILIO_NUMBER_MONTHLY_FEE` (e.g. `1.15` for a US long code) to add that flat amount to each month that has Twilio texts. It's opt-in because the fee is billed whether or not you send, it may be shared with other apps, and it isn't per org.

**RLS:** owners and admins can select. No insert or update policies exist, so rows are written only by the backend's privileged connection (send path, callback, reconcile).

**UI:** the YTD cards (2×3) add *Total Twilio spend* (e.g. "1,135 texts · $0.0124/text", with an "includes estimates" pill while any price is pending) and *Combined spend*. Each month card shows *AI spend · Twilio (texts, estimates) · Total*. Demo data includes plausible Twilio costs ($0.0118–$0.0133 per segment, about 15% of texts at 2 segments).

## Performance metrics (☰ → Performance metrics, all members)

**Attribution:** a purchase counts as a conversion for the *most recent* send to the same customer made within **N days**
before it (default 7; `GET /api/metrics/performance?days=N`, 1–90). If that send featured a promotion with categories or
products, only purchase lines in those categories/products count (the POS has no promo codes, so category/product is the
match); a send without a promotion counts any line. Each purchase line is credited to at most one send. Attributed
revenue is the sum of those lines; AOV = attributed revenue ÷ attributed orders.

The page shows: attributed revenue month to date vs the same days of last month (growth %, see below), YTD, conversion rate, AOV and a 6-month bar
chart (inline SVG, no chart dependency); promotions this year with usage % (share of sends that featured it), sends,
conversions, conversion rate and revenue; and a leaderboard (Today / This week / This month / All time) with rank,
initials avatar, sends, conversions (progress bar), conversion rate and revenue, 🥇🥈🥉 for the top 3, an **On fire**
badge (≥30% conversion on ≥5 sends), a **N-day streak** badge (≥3 consecutive days with sends) and an all-members totals row.
Staff see everyone's sends/conversions but only their own revenue (others show "—").

**Demo data:** `src/data/demoMetrics.ts` generates ~5 months of usage, sends by four fictional staff ("Maya R. (demo)" …)
and purchases, deterministically. Rows are `is_demo = true` (Postgres seed) and the pages show an "includes demo data"
pill. Demo purchases never appear in the deck's customer history. RLS: members can't insert `is_demo` rows.

**Month-over-month growth is like-for-like.** On day N of a month, "Month to date" covers day 1 through now. It is compared with sends from day 1 through the same day and time of last month (clamped to last month's final day, e.g. Mar 31 → Feb 28). For that comparison, last month only counts purchases made by the same cut-off, so neither period gets extra days to convert. The card also shows the full previous month's total for context. Previously a partial month was compared with a full one, which showed misleading drops like ▼95% early in the month. Early in a month the sample is small, so expect noisy percentages.

Summary cards (here and on Cost metrics) share a `MetricCard` layout: a small uppercase label, the value, then a green ▲ / red ▼ growth pill or a gray context line. The grid is 2×2 on desktop and 1 column under 640px.
