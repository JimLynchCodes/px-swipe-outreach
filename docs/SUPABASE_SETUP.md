# Supabase setup

The app uses **Supabase Auth** for sign-in and **Supabase Postgres** for data, with Row Level Security (RLS) on every table.

## 1. Create the project
1. Create a project at <https://supabase.com/dashboard>.
2. **Project Settings → API**: copy the **Project URL** and the **anon / publishable** key (frontend).
3. **Project Settings → Database → Connection string**: copy the URI for the backend `DATABASE_URL` (Supavisor session `:5432` or transaction `:6543`). Optionally download the CA cert for `DATABASE_CA_CERT`.

> 🔐 The `service_role` / `sb_secret_…` key and the DB password are **backend-only secrets**. The frontend never needs them, and it refuses to start if `VITE_SUPABASE_ANON_KEY` holds a service_role key.

## 2. Apply the schema
With the Supabase CLI (recommended):
```bash
supabase link --project-ref <ref>
supabase db push            # applies supabase/migrations/*
```
Or without the CLI:
```bash
cd retail-outreach-backend
DATABASE_URL=postgres://... npm run db:migrate
```
`db:migrate` takes an advisory lock and records applied files in `supabase_migrations.schema_migrations` (the same table the CLI uses), so the two are interchangeable.

## 3. Auth settings (Dashboard → Authentication)
- **URL Configuration**: Site URL = your frontend origin (e.g. `https://outreach.example.com`). Add `https://outreach.example.com/` and `http://localhost:5173/` to **Redirect URLs** (magic links and confirmations return there).
- **Providers → Email**: enable; keep *Confirm email* on.
- **Signing keys**: asymmetric (ES256/RS256) keys are recommended. The backend then verifies tokens via `SUPABASE_URL/auth/v1/.well-known/jwks.json` and needs **no secret**. Legacy HS256 projects: set `SUPABASE_JWT_SECRET`.
- Configure a custom SMTP provider before going live (the built-in mailer is heavily rate-limited, roughly a few emails per hour, which also limits team invitations).
- **Redirect URLs for invitations**: also add `https://outreach.example.com/invite/accept**` and `http://localhost:5173/invite/accept**`. Invite emails link back there with a `?token=` the backend checks.
- **Email templates**: the *Invite user* template is used for people who have no account yet; *Magic Link* is used when the invitee already has one. Both keep `{{ .ConfirmationURL }}`; rewording them (e.g. "You've been invited to join your team on Outreach") is optional.

## 4. Create the first organization
Sign up once in the app (or invite the user in the dashboard), then:
```bash
cd retail-outreach-backend
DATABASE_URL=postgres://... npm run db:seed -- --owner-email you@example.com
```
This creates an org and makes that user its **owner**. Seed data is demo customers; for real data, import into `customers`, `purchases`, `stores` for that `org_id`.

## 5. Configure the apps
Backend (`retail-outreach-backend/.env`):
```
NODE_ENV=production
AUTH_MODE=supabase
SUPABASE_URL=https://<ref>.supabase.co
DATA_STORE=postgres
DATABASE_URL=postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
CORS_ORIGIN=https://outreach.example.com
APP_URL=https://outreach.example.com
INVITE_MAILER=supabase
SUPABASE_SERVICE_ROLE_KEY=<service_role / sb_secret_ key>   # backend only, used solely to send invite emails
```
Frontend build env:
```
VITE_SUPABASE_URL=https://<ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon or publishable key>
```

## How data access works
- The backend verifies the user's JWT (issuer, audience, `role=authenticated`, expiry), then checks the `X-Org-Id` header against `memberships`.
- Each request runs in a transaction that sets `request.jwt.claims` and `SET LOCAL ROLE authenticated`, so **RLS policies are enforced on every query**, even if application code has a bug.
- Background work (the BullMQ worker, demo reset) uses the privileged connection. This requires the connecting role (Supabase's `postgres`) to be a member of `authenticated` and have `BYPASSRLS`. Both are true on Supabase by default.
- Opt-outs live in `suppressions`; a trigger on `message_deliveries` rejects any delivery to a suppressed recipient (defence in depth on top of the API check).

## Team invitations
Owners and admins invite teammates from **Team** (header icon → `/team`).
1. The backend creates a row in `invitations` (as the inviting user, so RLS applies) holding only a **SHA-256 hash** of a random 256-bit token. It expires after `INVITE_TTL_HOURS` (7 days).
2. The mailer calls Supabase Auth with the service-role key: `POST /auth/v1/invite` for new addresses, or a magic link (`/auth/v1/otp`, `create_user: false`) when the user already exists. The redirect is `${APP_URL}/invite/accept?token=…`.
3. The invitee lands on `/invite/accept`, signs in (or is signed in by the invite link), and clicks **Accept**. `accept_invitation()` checks the token, expiry and that the signed-in email matches, then creates the membership atomically.

Rules (enforced by the API **and** by RLS/triggers): only owners/admins invite; only owners grant or modify the `owner` role; an org can never lose its last owner; anyone may leave. Resending rotates the token, so older links stop working. Every change is written to `outreach_events`.

In development `INVITE_MAILER=console` logs the link instead, and the Team screen shows it so you can copy it.

## Local development without Supabase
- `npm run dev` with no Supabase env: frontend demo mode + backend `AUTH_MODE=demo` + in-memory data.
- Plain Postgres: `npm run db:migrate:local` creates stand-ins for Supabase's roles and `auth` schema (`supabase/tests/bootstrap_plain_postgres.sql`). Never run that against a real Supabase project.
- `supabase start` also works (see `supabase/config.toml`).
