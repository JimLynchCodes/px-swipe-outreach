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

Then open http://localhost:5173. With no Supabase config this runs in **demo mode** (no login, in-memory data).

## Production setup

Production uses **Supabase** for auth (email + password, magic links) and Postgres, with multi-tenant orgs and RLS on every table.

* [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md): create the project, apply migrations, configure auth, and create the first org.
* [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): Docker images, the production checklist, and compose.
* [docs/SECURITY.md](docs/SECURITY.md): secrets, auth, tenancy/RLS, opt-out and HTTP hardening.

CI (`.github/workflows/ci.yml`) runs lint, typecheck, tests and build for both projects, RLS integration tests against Postgres, and Docker builds.

Other root scripts:

| Script | What it does |
| --- | --- |
| `npm run build` | Builds both projects (`dist/` in each) |
| `npm test` | Runs the backend tests (Vitest + `fastify.inject`), then the frontend tests (Vitest + Testing Library) |
| `npm run typecheck` | Type-checks both projects |
| `npm run lint` | ESLint for both projects |

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
├── docker-compose.yml              # local production-like stack
├── .github/workflows/ci.yml
├── docs/                           # Supabase setup, deployment, security
├── supabase/                       # migrations (schema + RLS), config.toml, plain-PG bootstrap for tests
├── retail-outreach-backend/        # API, auth, providers, worker, migrate/seed scripts
└── px-swipe-outreach-frontend/     # swipe UI + Supabase Auth
```

## Roadmap

These pieces are still stubbed:

* **POS integration.** Replace the seed data with a sync from Shopify, Square, Lightspeed or Clover into the Postgres schema.
* **Real delivery.** Add `MessageProvider`s for Twilio (SMS) and SendGrid or Postmark (email). This also needs opt-out (STOP) handling, quiet hours and per-customer frequency caps.
* **Team management.** Done: invites, roles and removal at `/team` (see [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md#team-invitations)). Still to do: org creation/self-serve onboarding and ownership-transfer UX.
* **LLM.** Set `OPENAI_API_KEY` to enable the OpenAI provider. Prompt tuning, brand voice and evals still need work.
* **Analytics.** Track send → redeem → revenue attribution.
* **Inbound STOP handling.** Wire provider webhooks into `suppressions`.
