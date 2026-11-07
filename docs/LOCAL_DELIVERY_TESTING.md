# Local delivery testing (free tools only)

Real email and a simulated phone, on your machine, at no cost. Nothing reaches a real customer.

| Channel | Dev / local | Production |
|---|---|---|
| Email | `EMAIL_PROVIDER=smtp` → **Mailpit** (free, open source, MIT) catches every message at http://localhost:8025 | `EMAIL_PROVIDER=smtp` → any SMTP server, e.g. **Gmail with an app password** (free) |
| SMS | `SMS_PROVIDER=simulator` → **dev phone** at http://localhost:3000/dev/phone | `SMS_PROVIDER=twilio` (optional and **paid**; there is no free real SMS API) |
| Either | `log` prints to the API log instead of sending | `log` and `simulator` are **refused at startup** in production |

Email goes out through [Nodemailer](https://nodemailer.com) (MIT-0). Every outreach email carries:
- a unique, HMAC-signed unsubscribe link in the body, plus `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers (RFC 8058), and
- `Reply-To: reply+<token>@<INBOUND_EMAIL_DOMAIN>`, which threads replies into the Replies inbox. Locally the domain defaults to
  `reply.localhost` so the dev "simulate reply" form works. **Real inbound email needs a provider** that posts incoming mail to
  `POST /webhooks/email/inbound?key=$INBOUND_EMAIL_SECRET` (e.g. SendGrid Inbound Parse, Mailgun Routes, Postmark Inbound,
  or Cloudflare Email Routing + a Worker), with MX records for `INBOUND_EMAIL_DOMAIN` pointed at it.

SMS replies from the dev phone go through the **same** inbound Twilio webhook route as production
(`POST /webhooks/twilio/sms/:orgId`). If `TWILIO_AUTH_TOKEN` is set, the simulator signs requests like Twilio does, so signature
checking is exercised too. STOP/START/JOIN/HELP and free-text replies behave exactly as they would from a real phone.

Email-to-SMS carrier gateways (`number@vtext.com` and similar) were left out on purpose. Several US carriers have shut them down or
silently drop the mail, there's no delivery status and no STOP handling, and they don't work for compliant marketing.

## Prerequisites

- Node 20+, `npm run install:all` once.
- Mailpit, either through **Docker** (`docker compose up -d mailpit`) or the **single binary** (no Docker:
  https://mailpit.axllent.org/docs/install/, then run `mailpit`). Both listen on SMTP `1025` and the UI on `8025`.

## Option A: one command (Docker for Mailpit, Node for the app)

```bash
npm run dev:mail
```

That starts Mailpit, then the API with `EMAIL_PROVIDER=smtp SMTP_HOST=127.0.0.1 SMTP_PORT=1025 SMS_PROVIDER=simulator`, and the web
app (http://localhost:5173). On Windows, use Option B or WSL (the script sets env vars Unix-style).

## Option B: by hand

```bash
mailpit                                   # or: docker compose up -d mailpit
cd retail-outreach-backend
EMAIL_PROVIDER=smtp SMTP_HOST=127.0.0.1 SMTP_PORT=1025 \
SMTP_FROM="Cloud 9 Smoke Shop <deals@cloud9.test>" SMS_PROVIDER=simulator npm run dev
# second terminal
cd px-swipe-outreach-frontend && npm run dev
```

Use `127.0.0.1` rather than `localhost`: on some machines `localhost` resolves to IPv6 `::1`, which the Mailpit binary doesn't listen on.
The API log should say `email=smtp, sms=simulator` and `SMS simulator: open http://localhost:3000/dev/phone`.

## Option C: whole stack in Docker

```bash
docker compose up --build -d && docker compose run --rm migrate
```

Compose defaults to `EMAIL_PROVIDER=smtp` (→ the `mailpit` service) and `SMS_PROVIDER=simulator`. The queue worker posts simulator
texts to the API (`SMS_SIMULATOR_URL=http://api:3000`) so they show up on the same dev phone. Web: http://localhost:8080.

## Walkthrough: email

1. Open the app (http://localhost:5173, or :8080 for Docker). On the deck, pick a customer with email (Sarah Mitchell is first), switch
   the channel to **Email**, and send (Send button, swipe right, or →).
2. Open **Mailpit** at http://localhost:8025. The email is there. Check the **Headers** tab for `List-Unsubscribe`,
   `List-Unsubscribe-Post` and `Reply-To: reply+…@reply.localhost`.
3. Click the **Unsubscribe** link at the bottom of the email. The confirmation page opens. Click **Unsubscribe**. That POST is what
   opts the customer out (a GET alone never does, so link scanners can't). Mail clients' one-click unsubscribe POSTs the same URL.
4. In the app, open ☰ → **Opt-out list** and filter Email. Sarah is listed with source *Email unsubscribe*. Expand the row to see the
   consent event. Back on the deck, sending her an email is now blocked (SMS still works, since opt-outs are per channel).
5. On the confirmation page, click **Changed your mind? Resubscribe**. Refresh the Opt-out list and Sarah is gone. The history keeps
   both events.
6. *Simulated reply:* open http://localhost:3000/dev/phone and expand **Simulate an email reply**. Paste the `Reply-To` address from
   Mailpit, enter `sarah@example.com` (the address that was emailed) and some text, then click **Deliver**. ☰ → **Replies** shows it
   in Sarah's thread with an unread badge. A reply from any other address is ignored, just like the real webhook.

## Walkthrough: SMS

1. On the deck, pick a customer with SMS consent and send with channel **SMS**.
2. Open http://localhost:3000/dev/phone. The number appears on the left, and the text (ending in "Reply STOP to opt out.") shows as a
   received bubble.
3. Click **STOP** (or type `stop`). The webhook answers with the opt-out confirmation, which appears on the phone. ☰ → **Opt-out list**
   → SMS shows the customer with source *SMS STOP*, and sending them a text from the deck is blocked.
4. Click **START** (or **JOIN**). You get the resubscribe confirmation and the customer drops off the list. **HELP** returns the help
   text.
5. Type a normal message such as "Is the deal on today?". No auto-reply, but it lands in ☰ → **Replies**. Answer it there, and your
   reply shows up on the dev phone.

## Real email with Gmail (free)

1. Turn on 2-Step Verification for the Google account, then create an **App password** at https://myaccount.google.com/apppasswords.
2. Set:
   ```
   EMAIL_PROVIDER=smtp
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_USER=you@gmail.com
   SMTP_PASS=<the 16-character app password>
   SMTP_FROM="Your Shop <you@gmail.com>"
   ```
   Gmail rewrites `From` to the authenticated account, and personal accounts have a daily sending limit (about 500/day). Fine for testing
   and small shops. For volume, use any SMTP relay with the same variables.
3. Set `PUBLIC_API_URL` to a URL the recipient can reach (e.g. a free tunnel such as `cloudflared tunnel --url http://localhost:3000`).
   Otherwise unsubscribe links point at `localhost`.

## Twilio (optional, paid)

```
SMS_PROVIDER=twilio
TWILIO_ACCOUNT_SID=AC…
TWILIO_AUTH_TOKEN=…          # also verifies X-Twilio-Signature on inbound webhooks
TWILIO_FROM=+15551234567     # or a Messaging Service SID (MG…)
```
Point the number's "A message comes in" webhook at `https://<PUBLIC_API_URL>/webhooks/twilio/sms/<orgId>` (HTTP POST).
US A2P 10DLC registration is required for application-to-person SMS.

## Safety rails

- Startup validation: `smtp` needs `SMTP_HOST` + `SMTP_FROM` (and `SMTP_PASS` if `SMTP_USER` is set), and `twilio` needs SID, token and
  sender. In `NODE_ENV=production`, `EMAIL_PROVIDER` must be `smtp` (and not a local Mailpit host) and `SMS_PROVIDER` must be `twilio`.
- `/dev/phone` and `/api/dev/sim/*` are never registered in production. They're unauthenticated dev tools, so don't expose a dev
  server publicly. The worker → API simulator hand-off is keyed with an HMAC of `UNSUBSCRIBE_SIGNING_SECRET`.
- Suppression is re-checked right before every send, so a STOP or unsubscribe between queueing and sending still blocks it.

## Automated tests

`retail-outreach-backend/test/delivery.test.ts` covers this whole flow without Docker: it runs a real SMTP server in-process
(`smtp-server`), sends from the deck through Nodemailer, checks the raw headers, unsubscribes via the emailed link, checks the
Opt-out list, resubscribes, and simulates an email reply. It also tests the dev phone (STOP/START/HELP/free text through the real webhook,
with and without Twilio signing), the worker's simulator hand-off, the Twilio REST provider against a fake fetch, and that dev tools 404
in production. Config validation is in `test/hardening.test.ts`.
