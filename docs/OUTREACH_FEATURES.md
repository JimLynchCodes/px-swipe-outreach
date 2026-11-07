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
