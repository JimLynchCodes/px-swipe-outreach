# retail-outreach-backend

The Fastify API behind the PX Swipe Outreach app. It does four jobs:

1. Serves the deck of customers to contact.
2. Generates a suggested offer and message for each one.
3. Records skips.
4. Delivers messages through a pluggable provider.

## Running it

```bash
npm install
cp .env.example .env      # optional: every setting has a sensible default
npm run dev               # http://localhost:3000 (tsx watch)
```

This works out of the box with **no infrastructure**:

* `DATA_STORE=memory` serves 20 seeded customers. Restarting the server or calling `POST /api/dev/reset` restores them.
* `DELIVERY_MODE=inline` sends during the request.
* The `console` providers log the SMS or email (with the recipient masked) instead of sending it.

### With Postgres (and optionally Redis)

The schema lives in [`../supabase/migrations`](../supabase/migrations) and is shared with the Supabase CLI. See [docs/SUPABASE_SETUP.md](../docs/SUPABASE_SETUP.md).

```bash
# plain local Postgres (creates stand-ins for Supabase's roles + auth schema first)
export DATA_STORE=postgres DATABASE_URL=postgres://postgres:postgres@localhost:5432/outreach
npm run db:migrate:local
npm run db:seed -- --demo-user        # demo org owned by the demo user (AUTH_MODE=demo)
npm run dev

# optional: queue mode
export DELIVERY_MODE=queue REDIS_URL=redis://localhost:6379
npm run worker                        # in a second terminal
```

Against Supabase: `npm run db:migrate` (or `supabase db push`), then `npm run db:seed -- --owner-email you@example.com`.

In queue mode, `POST /send` returns `202 {status:"queued"}` and the BullMQ worker delivers the message. Retries use exponential backoff.

| Script | |
| --- | --- |
| `npm run dev` | Watch mode via tsx |
| `npm run build` / `npm start` | Compiles to `dist/`, then runs it |
| `npm test` / `npm run test:watch` | Vitest (unit + API) |
| `npm run test:db` | RLS/tenancy integration tests. Needs `TEST_DATABASE_URL` (**wipes that database**) |
| `npm run lint` / `npm run typecheck` | ESLint / `tsc --noEmit` |
| `npm run db:migrate` / `db:migrate:local` / `db:migrate:prod` | Apply migrations (Supabase / plain PG / from `dist`) |
| `npm run db:seed` | `--demo-user` or `--owner-email <email>` |
| `npm run worker` | BullMQ delivery worker (queue mode only) |

## Environment variables

See [`.env.example`](.env.example) for the full annotated list. Empty values count as unset. With `NODE_ENV=production` the server **refuses to boot** unless `AUTH_MODE=supabase`, `DATA_STORE=postgres`, and `CORS_ORIGIN` lists https origins.

| Variable | Default | Notes |
| --- | --- | --- |
| `AUTH_MODE` | `demo` | `demo` (dev only) or `supabase` |
| `SUPABASE_URL` | – | Required for `supabase`. Tokens are verified via the project JWKS |
| `SUPABASE_JWT_SECRET` | – | Only for legacy HS256 projects |
| `SUPABASE_JWT_AUDIENCE` | `authenticated` | |
| `DATA_STORE` | `memory` | `memory` or `postgres` |
| `DATABASE_URL` | – | Required when `DATA_STORE=postgres`. Backend secret |
| `DATABASE_POOL_MAX` / `DATABASE_CA_CERT` | `10` / – | CA cert as PEM text or a file path |
| `CORS_ORIGIN` | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated allowlist |
| `TRUST_PROXY` | `false` | Set `true` behind a load balancer |
| `RATE_LIMIT_PER_MINUTE` / `SEND_RATE_LIMIT_PER_MINUTE` | `300` / `30` | Per user (or IP when unauthenticated) |
| `ENABLE_DEMO_RESET` | on outside production | `POST /api/dev/reset` (owner/admin only) |
| `DELIVERY_MODE` / `REDIS_URL` | `inline` / – | `queue` needs Postgres and Redis |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | – / `gpt-4.1-mini` | Rules-based suggestions when unset |
| `SMS_PROVIDER` / `EMAIL_PROVIDER` | `console` | Only `console` is implemented so far |
| `LOG_LEVEL` / `SHUTDOWN_TIMEOUT_MS` | `info` / `10000` | |

## Auth

Every `/api/*` request needs `Authorization: Bearer <supabase access token>` (not in demo mode) and, except for `GET /api/me`, an `X-Org-Id` header naming an org the user belongs to. If the header is omitted and the user has exactly one org, that org is used. `GET /api/me` returns the user and their memberships. Errors look like `{error, code, requestId, details?}`. Health endpoints: `/health/live`, `/health/ready` (`/health` = ready).

## Architecture

```
src/
├── server.ts            # wires config → store/providers → app, graceful shutdown
├── app.ts               # buildApp(deps): plugins, auth hook, routes, error handler
├── config.ts            # zod-validated env
├── auth.ts              # demo resolveUser (replace with real auth)
├── types.ts / domain.ts # domain types, contact validation, card DTO mapping
├── data/seed.ts         # demo products, 20 customers, campaigns, offers
├── store/               # OutreachStore interface + MemoryStore + PostgresStore
├── providers/ai.ts      # SuggestionProvider: Rules, OpenAI, Fallback
├── providers/messaging.ts # MessageProvider: Console, ChannelRouter
├── delivery.ts          # processDelivery(): shared by inline mode and the worker
├── queue.ts / worker.ts # BullMQ
└── db/                  # pool, migrate (applies ../supabase/migrations), seed
```

How the pieces fit together:

* **Dependency injection.** `buildApp({config, store, suggestions, messenger})` makes the app trivially testable. The tests run `app.inject()` against a `MemoryStore`.
* **Swappable implementations.** `OutreachStore`, `SuggestionProvider` and `MessageProvider` are the extension points for a POS sync, an LLM and real SMS/email.
* **Idempotent sends.** Each `(opportunity, idempotencyKey)` pair is unique. Repeating a key returns the original delivery with `duplicate: true`, and a second send with a different key returns `409`.

## API reference

All `/api/*` routes run as the demo tenant. Errors look like `{ "error": string, "details"?: ... }`.

| Method & path | Body | Response |
| --- | --- | --- |
| `GET /health` | – | `{ok, store, delivery, ai, messaging}` |
| `GET /api/outreach/queue?limit=20` | – | `{items: Card[], total}`, with actionable cards in queue order (`limit` 1–100) |
| `GET /api/outreach/:id` | – | `Card` |
| `POST /api/outreach/:id/suggestion` | `{channel: "sms"\|"email"}` | `{suggestion: {title, reasoning, channel, message, subject, source}}` |
| `POST /api/outreach/:id/skip` | – | `{ok, status: "skipped"}` |
| `POST /api/outreach/:id/send` | `{channel, message, subject?, idempotencyKey}` | `200 {deliveryId, status:"sent"}` inline, or `202 {…status:"queued"}` in queue mode. Duplicates add `duplicate:true` |
| `GET /api/outreach/:id/deliveries` | – | `{deliveries: [...]}`, with recipients masked |
| `GET /api/metrics` | – | Counts by opportunity status and delivery status/channel |
| `POST /api/dev/reset` | – | Re-seeds demo data (not available in production) |

Status codes:

* `400`: validation failed.
* `404`: unknown opportunity.
* `409`: the card was already skipped or sent.
* `422`: the customer can't be reached on that channel.
* `429`: rate limited.
* `502`: the message provider failed. The delivery is stored as `failed`.

Validation limits: `message` can be up to 480 characters for SMS and 5000 for email. `idempotencyKey` must be 8–200 characters.

A `Card` looks like this:

```json
{
  "id": "opp_0001", "status": "pending", "rationale": "No purchase in 68 days",
  "campaign": {"id": "winback", "type": "win_back", "name": "Win-back"},
  "offer": {"id": "WINBACK10", "name": "Win-back 10%", "discountPercent": 10, "combinable": true},
  "customer": {
    "id": "cust_0001", "displayName": "Sarah M.", "firstName": "Sarah", "age": 34, "gender": "Female",
    "location": "Downtown", "storesShopped": ["Downtown", "Westside"], "lifetimeSpendCents": 86000,
    "daysSinceLastPurchase": 68, "itemsPurchased": 3,
    "contact": {"sms": true, "email": true, "preferredChannel": "sms"}
  },
  "lastPurchase": {"name": "Leather Tote Bag", "category": "bags", "priceCents": 16000, "imageUrl": null,
                   "daysAgo": 68, "alsoPurchased": ["Wallet", "Scarf"]}
}
```

Quick smoke test:

```bash
curl localhost:3000/api/outreach/queue?limit=1
curl -XPOST localhost:3000/api/outreach/opp_0001/suggestion -H 'content-type: application/json' -d '{"channel":"sms"}'
curl -XPOST localhost:3000/api/outreach/opp_0001/send -H 'content-type: application/json' \
  -d '{"channel":"sms","message":"Hi Sarah!","idempotencyKey":"demo-key-1"}'
```

## Testing

`npm test` covers:

* The queue/card shape, including that no contact details leak.
* Suggestions for SMS and email, and the channel-reachability check (422).
* Validation (400).
* Skip, and conflicts on repeated actions (404/409).
* Send idempotency and provider failure (502).
* Metrics and dev reset.
* The rules provider for every seeded campaign, and the OpenAI → rules fallback.
* Domain helpers.

Auth (JWKS/HS256 verification, issuer/audience/role checks, org resolution), hardening (CORS, headers, request IDs, rate limits, validation, error shape, log redaction) and opt-out enforcement are covered in `test/auth.test.ts` and `test/hardening.test.ts`.

`npm run test:db` applies the real migrations to a scratch Postgres and checks RLS directly: cross-org isolation for every table, membership role rules, the suppression trigger, delivery uniqueness and the append-only event log.
