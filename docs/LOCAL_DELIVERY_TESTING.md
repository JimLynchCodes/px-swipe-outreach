# Local delivery testing: real email (SMTP) and real SMS (Twilio)

| | `log` (default for `npm run dev`) | Live (`npm run dev:live`) |
|---|---|---|
| Email | Printed to the API log | `EMAIL_PROVIDER=smtp`: real email via [Nodemailer](https://nodemailer.com) (MIT-0) through any SMTP server (Gmail app password, your host, or optional Mailpit) |
| SMS | Printed to the API log, e.g. `[LOG SMS] to=+15***01 body="…"` | `SMS_PROVIDER=twilio`: real SMS via the official [`twilio`](https://www.npmjs.com/package/twilio) SDK (paid; trials are cheap) |

- **Switching** takes one command: `npm run dev` forces `log` for both channels, and `npm run dev:live` loads
  `retail-outreach-backend/.env.local` (Node `--env-file`). You can also flip `EMAIL_PROVIDER` / `SMS_PROVIDER` in any env.
- **Startup validation:** `smtp` needs `SMTP_HOST` and `SMTP_FROM` (plus `SMTP_PASS` if `SMTP_USER` is set). `twilio` needs
  `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER` or `TWILIO_MESSAGING_SERVICE_SID`. In production, `log` is
  refused for both channels. A bad config exits with a list of what's wrong.
- **Every email** carries a unique HMAC-signed unsubscribe link, `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
  headers (RFC 8058), and, when `INBOUND_EMAIL_DOMAIN` is set, a `Reply-To: reply+<token>@<domain>` that threads replies.
- **Every text** ends with "Reply STOP to opt out." Suppression is re-checked right before each send.

## 1. Create `.env.local`

```bash
cd retail-outreach-backend
cp .env.example .env.local      # .env.local is git-ignored
```
Edit the delivery block (sections 2 and 3 below), then run from the repo root:
```bash
npm run dev:live                # API :3000 + web :5173, real providers
```
The API's startup line says `email=smtp, sms=twilio`.

## 2. Email over SMTP

**Gmail (free):** turn on 2-Step Verification, create an App password at https://myaccount.google.com/apppasswords, then:
```
EMAIL_PROVIDER=smtp
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=you@gmail.com
SMTP_PASS=<16-character app password>
SMTP_FROM="Cloud 9 Smoke Shop <you@gmail.com>"
```
Gmail sends as the authenticated account and caps personal accounts at about 500 messages/day. Any other SMTP relay works with the same
variables (587 = STARTTLS, 465 = TLS).

**Optional: Mailpit** (free, open source) catches mail locally instead of delivering it. Run `docker compose --profile mail up -d mailpit`
or the [single binary](https://mailpit.axllent.org/docs/install/), then set `SMTP_HOST=127.0.0.1 SMTP_PORT=1025` with no user or password,
and read the mail at http://localhost:8025.

**Try it:** on the deck, pick a customer, switch to **Email**, and change their address to yours for testing (seed customers use
`@example.com`). Send, then open the email: click **Unsubscribe**, then **Unsubscribe** on the confirmation page (the POST is what opts
out; link scanners' GETs don't). ☰ → **Opt-out list** → Email shows them. **Changed your mind? Resubscribe** removes them again.

Real inbound email replies need an inbound-parse provider (SendGrid Inbound Parse, Mailgun Routes, Postmark Inbound, or Cloudflare
Email Routing + a Worker) that posts to `POST /webhooks/email/inbound?key=$INBOUND_EMAIL_SECRET`, with MX records for
`INBOUND_EMAIL_DOMAIN` pointed at it.

## 3. SMS with Twilio, step by step

1. **Trial account:** sign up at https://www.twilio.com/try-twilio and verify your email and your own mobile number.
2. **Buy a number:** Console → Phone Numbers → Manage → **Buy a number** with SMS capability. Trial credit covers it.
3. **Trial limits:** a trial account can **only text verified numbers** (Console → Phone Numbers → **Verified Caller IDs**), and
   messages are prefixed "Sent from your Twilio trial account". Verify the phone you'll test with.
4. **Production:** US application-to-person SMS from a 10-digit number requires **A2P 10DLC registration** (brand + campaign) under
   Messaging → Regulatory Compliance. Unregistered traffic is filtered or blocked. Toll-free numbers need toll-free verification instead.
5. **Env vars** (Console → Account info):
   ```
   SMS_PROVIDER=twilio
   TWILIO_ACCOUNT_SID=AC...
   TWILIO_AUTH_TOKEN=...                 # also verifies X-Twilio-Signature on inbound webhooks
   TWILIO_FROM_NUMBER=+15551234567       # the number you bought
   # or TWILIO_MESSAGING_SERVICE_SID=MG... (takes precedence over the number)
   ```
6. **Test send to your phone:** in the demo data, set a customer's phone to your verified number. In demo mode, edit
   `retail-outreach-backend/src/data/seed.ts` (e.g. Sarah Mitchell's `phone`). With Postgres, update `customers.phone`. Restart
   `npm run dev:live`, open http://localhost:5173, pick that customer, choose **SMS**, and send. The text arrives with
   "Reply STOP to opt out."

### Receiving STOP / START / replies locally (free tunnel)

Twilio has to reach your laptop, so expose port 3000 with a free tunnel:
```bash
npx localtunnel --port 3000                    # prints https://<name>.loca.lt
# or: cloudflared tunnel --url http://localhost:3000    # prints https://<name>.trycloudflare.com
```
1. Put the tunnel URL in `.env.local`: `PUBLIC_API_URL=https://<name>.trycloudflare.com`, and restart `npm run dev:live`.
   **This matters:** the webhook validates `X-Twilio-Signature` against `PUBLIC_API_URL` + path (the URL Twilio signed), not
   `localhost`. Unsubscribe links in emails use it too.
2. Find your org id: demo mode uses `00000000-0000-4000-8000-000000000101`. With Postgres, run `select id from organizations`.
3. Console → Phone Numbers → your number → **Messaging configuration** → "A message comes in": **Webhook**,
   `https://<tunnel>/webhooks/twilio/sms/<orgId>`, **HTTP POST**. Save.
   (localtunnel shows a reminder page to browsers but not to Twilio's POSTs. If it ever interferes, use cloudflared.)
4. From your phone, **reply STOP**. Twilio's own STOP handling also kicks in on the number. The app records the opt-out:
   ☰ → **Opt-out list** → SMS shows the customer with source *SMS STOP* (expand the row for the consent event), and sending them another
   text from the deck is blocked.
5. **Reply START** (or UNSTOP/JOIN). You get the resubscribe confirmation and they drop off the Opt-out list. **HELP** returns the help text.
6. Reply with normal text. It shows up in ☰ → **Replies**, and your answer from there goes back to your phone.

A wrong or missing `PUBLIC_API_URL` makes every webhook return **403** ("bad Twilio signature" in the API log). That's the first thing to
check.

## Automated tests

`retail-outreach-backend/test/delivery.test.ts`:
- **SMTP end to end** against a real in-process SMTP server (`smtp-server`): send from the deck, check the raw headers (`List-Unsubscribe`,
  `List-Unsubscribe-Post`, `Reply-To`), unsubscribe via the emailed link, see the Opt-out list, get blocked, resubscribe, and thread an
  inbound reply (spoofed senders are ignored).
- **Twilio provider** with a fake SDK client: number vs Messaging Service sender, SDK errors become a failed delivery (502), and config
  builds the real SDK client.
- **Inbound STOP/START** signed for a tunnel `PUBLIC_API_URL`: a signature for `localhost` is rejected (403), and the correct one opts out
  and back in on the Opt-out list.
- **log provider** output.

`test/hardening.test.ts` covers startup validation (missing SMTP/Twilio vars, bad number format, and `log` refused in production).

## Twilio spend tracking

With `SMS_PROVIDER=twilio` and a tunnel `PUBLIC_API_URL`, each text sets a StatusCallback to `<tunnel>/webhooks/twilio/status/<orgId>`. You don't need to configure anything in the Twilio console. Cost metrics shows the text as an estimate at first, then switches to Twilio's actual price once it's delivered. On localhost without a tunnel, the reconcile job (every `TWILIO_RECONCILE_MINUTES`) fills in prices instead. See [OUTREACH_FEATURES.md](OUTREACH_FEATURES.md#twilio-spend).
