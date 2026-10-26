# PX Swipe Outreach

Swipe-to-send customer outreach for retailers. Each card is a past customer: their spend, what they last bought, and an AI-suggested win-back message. **Swipe right (or tap Send)** to send the message by SMS or email. **Swipe left (or tap Skip)** to move to the next customer.

| Project | Stack | Port |
| --- | --- | --- |
| [`retail-outreach-backend`](retail-outreach-backend/README.md) | Node 20, Fastify 5, Zod, TypeScript. Optional Postgres, Redis/BullMQ and OpenAI | 3000 |
| [`px-swipe-outreach-frontend`](px-swipe-outreach-frontend/README.md) | React 18, Vite 6, TypeScript, lucide-react | 5173 |

## Quick start

You need Node 20 or later. **No database, Redis or API keys are required.** The backend starts with an in-memory store seeded with 20 demo customers, rules-based suggestions, and a console "sender" that logs messages instead of sending them.

```bash
npm run install:all   # installs the root, backend and frontend
npm run dev           # backend on :3000 and frontend on :5173 together
```

Then open http://localhost:5173.

Other root scripts:

| Script | What it does |
| --- | --- |
| `npm run build` | Builds both projects (`dist/` in each) |
| `npm test` | Runs the backend tests (Vitest + `fastify.inject`), then the frontend tests (Vitest + Testing Library) |
| `npm run typecheck` | Type-checks both projects |

## Architecture

```
┌──────────── Browser ────────────┐        ┌──────────────── retail-outreach-backend ────────────────┐
│ React app (Vite)                │ /api/* │ Fastify: helmet, CORS, rate limit, auth hook, zod       │
│  CustomerCard  ◀── queue ───────┼───────▶│  routes (app.ts)                                        │
│  swipe / keys ── skip / send ───┼───────▶│   ├─ OutreachStore ─ MemoryStore (default) | Postgres   │
│                                 │        │   ├─ SuggestionProvider ─ rules | OpenAI (+fallback)    │
│ dev: Vite proxies /api → :3000  │        │   └─ delivery ─ inline | BullMQ queue → worker          │
└─────────────────────────────────┘        │                 └─ MessageProvider ─ console (SMS/email)│
                                           └─────────────────────────────────────────────────────────┘
```

* **Frontend → backend.** In development the browser calls relative `/api/...` URLs and the Vite dev server proxies them to `VITE_PROXY_TARGET` (default `http://localhost:3000`), so CORS never comes into play. For a split deployment, set `VITE_API_BASE_URL` at build time and add the frontend origin to the backend's `CORS_ORIGIN`.
* **Card flow.**
  1. `GET /api/outreach/queue` returns the deck.
  2. For the top card, the app calls `POST /api/outreach/:id/suggestion` with the selected channel to get the title, reasoning and message.
  3. The user can edit the message.
  4. **Send** posts the final text with an idempotency key. **Skip** marks the card skipped.
* **Privacy.** The API never returns raw phone numbers or email addresses. Cards only expose `contact.sms` and `contact.email` booleans, and delivery records show masked recipients.

See each project's README for its env vars, API reference and internals.

## Repository layout

```
.
├── package.json                    # root scripts (concurrently)
├── retail-outreach-backend/        # API, seed data, providers, Postgres schema, worker
└── px-swipe-outreach-frontend/     # swipe UI
```

## Roadmap

These pieces are still stubbed:

* **POS integration.** Replace the seed data with a sync from Shopify, Square, Lightspeed or Clover into the Postgres schema.
* **Real delivery.** Add `MessageProvider`s for Twilio (SMS) and SendGrid or Postmark (email). This also needs opt-out (STOP) handling, quiet hours and per-customer frequency caps.
* **Auth.** Replace the dev user and tenant in `auth.ts` with real sessions or JWT (for example Clerk, Auth0 or Supabase).
* **LLM.** Set `OPENAI_API_KEY` to enable the OpenAI provider. Prompt tuning, brand voice and evals still need work.
* **Deployment and analytics.** Containerize, add CI, and track send → redeem → revenue attribution.
