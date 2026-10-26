# Retail Outreach Backend (starter)

Node.js + TypeScript backend scaffold for a Tinder-style retail customer outreach app.

## Included
- Fastify API routes for next opportunity, generate/regenerate, edit draft, skip, send, status, metrics.
- PostgreSQL schema and migration runner.
- BullMQ delivery queue and worker.
- OpenAI structured-output message drafting with a safe, constrained prompt.
- Mock POS adapter and console SMS/email adapters so it runs without vendor credentials.
- Contact-consent checks, offer validation, tenant-scoped query patterns, and idempotency handling.

## Run locally
1. Install Node.js 20+ and Docker.
2. `cp .env.example .env`
3. `docker compose up -d`
4. `npm install`
5. `npm run db:migrate`
6. In one terminal: `npm run dev`
7. In another terminal: `npm run worker`

API is at `http://localhost:3000`. This starter seeds demo data when the migration runs.

## Demo API
Development mode uses a demo user/tenant from `.env`. Do not use this authentication mode in production.

- `GET /health`
- `GET /api/outreach/next`
- `POST /api/outreach/:id/generate` body `{ "channel": "sms" }`
- `PATCH /api/outreach/:id/draft` body `{ "channel": "sms", "message": "Edited message", "subject": null }`
- `POST /api/outreach/:id/skip`
- `POST /api/outreach/:id/send` body `{ "channel": "sms", "idempotencyKey": "unique-client-generated-key" }`
- `GET /api/outreach/:id/status`
- `GET /api/outreach/metrics`

The app chooses SMS by default if a usable phone number exists. If not, it falls back to email if available. Staff may manually switch channels if the customer has that contact method and valid consent.

## Before production
This is a runnable foundation, not a production-certified deployment. You must:
- Replace demo auth with verified sessions/JWT and role-based authorization.
- Replace the mock POS adapter and console message providers.
- Implement provider-specific consent/opt-out sync, webhook signature verification, and unsubscribe handling.
- Review privacy, retention, messaging laws, store/tenant isolation, audit access, and secret management.
- Add integration tests, monitoring, rate limits per tenant, queue recovery/dead-letter handling, and delivery provider idempotency.
- Validate offers against your POS/promotion engine. The sample discount data is illustrative.
- Configure OpenAI data controls and only send the minimum customer data required.

Never expose API keys in the browser or Electron renderer. Do not use age or gender as a proxy for sensitive assumptions; the demo fields are illustrative only.
