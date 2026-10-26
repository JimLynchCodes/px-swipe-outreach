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

```bash
docker compose up -d                  # Postgres 16 + Redis 7
export DATA_STORE=postgres DATABASE_URL=postgres://outreach:outreach@localhost:5432/outreach
npm run db:migrate                    # applies src/db/schema.sql and upserts demo data (--no-seed to skip)
npm run dev

# optional: queue mode
export DELIVERY_MODE=queue REDIS_URL=redis://localhost:6379
npm run worker                        # in a second terminal
```

In queue mode, `POST /send` returns `202 {status:"queued"}` and the BullMQ worker delivers the message. Retries use exponential backoff.

| Script | |
| --- | --- |
| `npm run dev` | Watch mode via tsx |
| `npm run build` / `npm start` | Compiles to `dist/` (and copies `schema.sql`), then runs it |
| `npm test` / `npm run test:watch` | Vitest |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:migrate` | Applies the schema and seeds demo data (Postgres only) |
| `npm run worker` | BullMQ delivery worker (queue mode only) |

## Environment variables

Empty values count as unset.

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | In `production`, demo auth and `/api/dev/*` are refused |
| `HOST` / `PORT` | `0.0.0.0` / `3000` | |
| `CORS_ORIGIN` | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated list. `*` allows any origin |
| `DATA_STORE` | `memory` | `memory` or `postgres` |
| `DATABASE_URL` | – | Required when `DATA_STORE=postgres` |
| `DELIVERY_MODE` | `inline` | `inline` or `queue`. `queue` needs Postgres and Redis |
| `REDIS_URL` | – | Required when `DELIVERY_MODE=queue` |
| `OPENAI_API_KEY` | – | If set, suggestions come from OpenAI, falling back to rules on any error |
| `OPENAI_MODEL` | `gpt-4.1-mini` | |
| `SMS_PROVIDER` / `EMAIL_PROVIDER` | `console` | Only `console` is implemented so far |
| `BUSINESS_NAME` | `our store` | Used in message copy |
| `DEV_USER_ID` / `DEV_TENANT_ID` | `demo-user` / `demo-retailer` | Demo identity attached to every request |

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
└── db/                  # schema.sql, pool, migrate, seed
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

`PostgresStore` was verified by hand against a real Postgres 16 instance (migrate → queue → suggestion → send/duplicate → skip → metrics → reset). Automated tests for it are a good next step, for example with Testcontainers.
