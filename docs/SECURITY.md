# Security model

## Secrets
| Secret | Where it lives | Never in |
|---|---|---|
| Supabase `service_role` / `sb_secret_` key | not used by this app | anywhere in the frontend |
| `DATABASE_URL` (DB password) | backend/worker env | frontend, git, logs |
| `SUPABASE_JWT_SECRET` (legacy HS256 only) | backend env | frontend |
| `OPENAI_API_KEY`, SMS/email provider keys | backend env | frontend |

Only `VITE_SUPABASE_URL` and the anon/publishable key are shipped to browsers. The frontend refuses a service_role or secret key at startup.

## Authentication
- Supabase Auth (email + password, magic link). Sessions persist in the browser and refresh automatically (PKCE flow). On any API `401` the app signs out.
- The API verifies every bearer token: signature (JWKS, or HS256 for legacy projects), `iss = SUPABASE_URL/auth/v1`, `aud = authenticated`, `role = authenticated`, `exp`. Anonymous/service tokens are rejected.
- `AUTH_MODE=demo` (a fixed demo user) exists for local development and is refused when `NODE_ENV=production`.

## Authorization and tenancy
- Every row has `org_id`. Users access an org only through `memberships` (`owner`, `admin`, `member`).
- The API checks the requested `X-Org-Id` against memberships, **and** each query runs as the `authenticated` role with the user's JWT claims, so Postgres RLS enforces tenancy independently.
- RLS is enabled on every table. Delivery records cannot be updated by users, and the event log is append-only.
- Destructive operations (demo reset) require `owner`/`admin` and are disabled in production.

## Messaging safety
- **Opt-out**: `suppressions` per org, channel and normalized recipient. Enforced in the API, again in the worker right before sending, and by a database trigger.
- **Idempotent sends**: clients send an `idempotencyKey`. Retries return the original delivery, and a partial unique index allows only one live delivery per opportunity.
- Separate, stricter rate limit on the send endpoint.

## HTTP hardening
helmet (strict CSP `default-src 'none'` on the API, HSTS, nosniff, frame-deny), CORS allowlist, 64 KB body limit, strict zod validation (unknown fields rejected), uniform error bodies `{error, code, requestId}` with no stack traces, and per-user rate limiting.

## Reporting
Please report vulnerabilities privately to the maintainer rather than opening a public issue.
