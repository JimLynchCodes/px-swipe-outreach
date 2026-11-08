# Supabase setup

The app uses **Supabase Auth** for sign-in and **Supabase Postgres** for data, with Row Level Security (RLS) on every table.

## 1. Create the project
1. Create a project at <https://supabase.com/dashboard>.
2. **Project URL**: shown under **Project Settings → Data API** (also in the **Connect** dialog). Use it for `SUPABASE_URL` / `VITE_SUPABASE_URL`.
3. **Project Settings → API Keys**:
   - **Publishable key** (`sb_publishable_…`) → frontend `VITE_SUPABASE_PUBLISHABLE_KEY`. Legacy: the **anon** key (*Legacy API keys* tab) still works via the alias `VITE_SUPABASE_ANON_KEY`.
   - **Secret key** (`sb_secret_…`) → backend `SUPABASE_SECRET_KEY`, only needed for invite emails. Legacy: the **service_role** key still works via the alias `SUPABASE_SERVICE_ROLE_KEY`.
4. **Connect** (top bar) → **Connection string**: copy the URI for the backend `DATABASE_URL` (Supavisor session `:5432` or transaction `:6543`).
5. Optional: **Project Settings → Database → SSL Configuration** → download the CA certificate for `DATABASE_CA_CERT` (verified TLS). Without it the connection is still encrypted, but the server certificate isn't verified against Supabase's CA.

> 🔐 The `service_role` / `sb_secret_…` key and the DB password are **backend-only secrets**. The frontend never needs them, and it refuses to start if its key is a `sb_secret_…` or service_role key.

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

## 4. Create the first organization / first owner

**Recommended: `BOOTSTRAP_OWNER_EMAILS`.** Put your email in the backend env (`BOOTSTRAP_OWNER_EMAILS=mrdotjim@gmail.com`;
comma-separate several). When that person signs in with a **confirmed** email and isn't on any team yet, the API makes them
**owner** of the default org: the oldest organization, or a new one named `BOOTSTRAP_ORG_NAME` (default "My Store") when there
are none. The match is case-insensitive. Confirmation is checked in `auth.users.email_confirmed_at`, not trusted from the browser.
Removing the email later doesn't remove the membership; manage that on the Team page.

The login page has no sign-up link, so create the Auth user first: **Authentication → Users → Add user → Create new user**
(email + password, tick **Auto Confirm User**). Or use **Send invitation** and set a password from the email link.

**Alternative (CLI, no restart needed):** after the user exists and is confirmed:
```bash
cd retail-outreach-backend
npx tsx --env-file=.env.supabase.local src/db/bootstrapOwnerCli.ts mrdotjim@gmail.com
# or, with DATABASE_URL already in your shell / .env:
npm run bootstrap:owner -- mrdotjim@gmail.com --org-name "Cloud 9"
```
**Or in SQL** (Dashboard → SQL Editor), for an existing confirmed user and an existing org:
```sql
insert into public.memberships (org_id, user_id, role)
select (select id from public.organizations order by created_at limit 1), u.id, 'owner'
from auth.users u where lower(u.email) = lower('mrdotjim@gmail.com') and u.email_confirmed_at is not null
on conflict (org_id, user_id) do update set role = 'owner';
```

**With demo data:** sign up once in the app (or invite the user in the dashboard), then:
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
SUPABASE_SECRET_KEY=<sb_secret_… key (or legacy service_role)>   # backend only, used solely to send invite emails
PUBLIC_API_URL=https://api.outreach.example.com
UNSUBSCRIBE_SIGNING_SECRET=<openssl rand -base64 48>
TWILIO_AUTH_TOKEN=<twilio auth token>
INBOUND_EMAIL_DOMAIN=reply.outreach.example.com
INBOUND_EMAIL_SECRET=<openssl rand -hex 24>
```
Frontend build env:
```
VITE_SUPABASE_URL=https://<ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<sb_publishable_… key>   # legacy alias: VITE_SUPABASE_ANON_KEY
```

## How data access works
- The backend verifies the user's JWT (issuer, audience, `role=authenticated`, expiry), then checks the `X-Org-Id` header against `memberships`.
- Each request runs in a transaction that sets `request.jwt.claims` and `SET LOCAL ROLE authenticated`, so **RLS policies are enforced on every query**, even if application code has a bug.
- Background work (the BullMQ worker, demo reset) uses the privileged connection. This requires the connecting role (Supabase's `postgres`) to be a member of `authenticated` and have `BYPASSRLS`. Both are true on Supabase by default.
- Promotions (`deals`) and `org_settings`: members read, owners/admins write. `conversations` / `messages`: members read and mark read; staff can insert outbound messages only with `sent_by = auth.uid()`. Inbound messages, STOP/unsubscribe opt-outs and webhook work use the privileged connection, scoped by org in code.
- Opt-outs live in `suppressions` (with a `source`: `sms_stop`, `email_unsubscribe`, `manual` or `provider`); a trigger on `message_deliveries` rejects any delivery to a suppressed recipient (defence in depth on top of the API check).

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

## Switching between demo data and Supabase

| Command (repo root) | Data | Auth | Reads |
|---|---|---|---|
| `npm run dev` | In-memory demo data (resets on restart) | Demo user, no login | nothing (forces `DATA_STORE=memory AUTH_MODE=demo`, log delivery) |
| `npm run dev:supabase` | Your Supabase Postgres | Supabase login page | `retail-outreach-backend/.env.supabase.local` + `px-swipe-outreach-frontend/.env.supabase.local` |

Setup once: copy both `.env.supabase.example` files to `.env.supabase.local` and fill them in (the backend file holds
`DATABASE_URL` and the service-role key; the frontend file holds only the URL and the publishable key). Then, once:
```bash
cd retail-outreach-backend
npx tsx --env-file=.env.supabase.local src/db/migrate.ts
npx tsx --env-file=.env.supabase.local src/db/seed.ts --owner-email you@example.com   # an existing Supabase Auth user becomes owner
``` The header shows a badge,
**Demo data** or **Supabase**, so you always know which one you're looking at (it comes from the API's `DATA_STORE`).

## Who can get in (approval gate)

In Supabase mode everything sits behind the login page, and **only people on an org's Team list can use the app**:

- **Active members** get in.
- **Pending invitees:** if the signed-in email matches (case-insensitive) an unexpired, unrevoked pending invitation, the user is
  **auto-joined** with the invited role on first sign-in, the same as clicking the invite link
  (`public.claim_pending_invitations()`, a narrow `security definer` function). The invite is marked accepted and audited
  (`invitation_accepted`, `via: sign_in`).
- **Bootstrap owners:** emails in `BOOTSTRAP_OWNER_EMAILS` with a confirmed email and no membership become owner of the default org on sign-in (section 4).
- **Everyone else** sees exactly: "`<email>` has not been approved for this application. If this is in error, please contact your
  administrator." along with a Sign out button. The API answers **403 `not_approved`** on every `/api` route, including `/api/me`.
  The only exception is the invite-accept endpoint, so an invite link can still turn someone into a member.
- Removed members whose old invitation was "accepted" do **not** get back in. Access follows current membership, so removing someone
  from the team revokes it. Expired and revoked invitations don't count either.
- The database enforces this too: every table's RLS is keyed on `is_org_member`/`has_org_role`, so a signed-in user without a
  membership reads and writes nothing even when going straight at PostgREST with their JWT.

**Sign-ups:** the login page has no "Create an account" link (invite links still let invitees create their account). **Also turn
off open sign-ups in the dashboard**: Authentication → Sign In / Providers → uncheck *Allow new users to sign up*. Invitations
(`auth.admin.inviteUserByEmail`) keep working. The first owner comes from `BOOTSTRAP_OWNER_EMAILS`, `npm run bootstrap:owner`, or the seed script (section 4).
