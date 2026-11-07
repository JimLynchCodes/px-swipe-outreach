-- Data sync (formerly the separate ETL project): per-org schedules, a run log with a per-job lock, watermarks,
-- and the tables each job loads. Jobs run in the backend with its privileged connection (service role only,
-- never the browser). Owners/admins can read everything here and edit schedules; nobody else can see sync data.

alter table public.org_settings add column timezone text not null default 'America/New_York'
  check (char_length(timezone) between 1 and 64);

-- ── Schedules ────────────────────────────────────────────────────────────────
create table public.sync_schedules (
  org_id       uuid not null references public.organizations (id) on delete cascade,
  job          text not null check (job in ('ai-usage', 'twilio', 'email', 'quickvee-rewards', 'quickvee-orders')),
  frequency    text not null default 'off' check (frequency in ('off', 'daily', 'weekly', 'monthly', 'yearly')),
  -- Wall-clock start in the org's timezone (org_settings.timezone). Runs at start + n × frequency.
  start_local  timestamp without time zone not null,
  -- Next due instant (UTC); null when off. The scheduler claims due rows with FOR UPDATE SKIP LOCKED.
  next_run_at  timestamptz,
  updated_by   uuid,
  updated_at   timestamptz not null default now(),
  primary key (org_id, job)
);
create index sync_schedules_due_idx on public.sync_schedules (next_run_at) where frequency <> 'off';

-- ── Run log (and lock) ───────────────────────────────────────────────────────
create table public.etl_runs (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations (id) on delete cascade,
  job           text not null,
  trigger       text not null check (trigger in ('manual', 'schedule', 'backfill', 'cli')),
  status        text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  dry_run       boolean not null default false,
  params        jsonb not null default '{}'::jsonb,
  progress      jsonb not null default '{}'::jsonb,
  rows_read     integer not null default 0,
  rows_written  integer not null default 0,
  error         text check (error is null or char_length(error) <= 2000),
  -- Structured log lines [{ at, level, msg, data? }], capped by the app (~500 lines).
  log           jsonb not null default '[]'::jsonb,
  started_by    uuid,
  started_at    timestamptz not null default now(),
  heartbeat_at  timestamptz not null default now(),
  finished_at   timestamptz
);
-- The lock: at most one running run per org and job. A run whose heartbeat is stale is failed before a new claim.
create unique index etl_runs_one_running on public.etl_runs (org_id, job) where status = 'running';
create index etl_runs_org_job_started_idx on public.etl_runs (org_id, job, started_at desc);

create table public.etl_watermarks (
  org_id      uuid not null references public.organizations (id) on delete cascade,
  job         text not null,
  -- Opaque per job (usually an ISO date/time of the last fully synced point).
  cursor      text not null,
  updated_at  timestamptz not null default now(),
  primary key (org_id, job)
);

-- ── Loaded data ─────────────────────────────────────────────────────────────
-- Provider-reported AI usage per day and model, reconciled against what the app recorded (ai_usage).
create table public.provider_usage_daily (
  org_id             uuid not null references public.organizations (id) on delete cascade,
  provider           text not null check (provider in ('openai', 'openrouter')),
  day                date not null,
  model              text not null check (char_length(model) <= 100),
  requests           integer not null default 0,
  input_tokens       bigint not null default 0,
  output_tokens      bigint not null default 0,
  cost_usd           numeric(14, 6) not null default 0,
  recorded_cost_usd  numeric(14, 6) not null default 0,
  recorded_calls     integer not null default 0,
  synced_at          timestamptz not null default now(),
  primary key (org_id, provider, day, model)
);

create table public.twilio_usage_daily (
  org_id     uuid not null references public.organizations (id) on delete cascade,
  day        date not null,
  category   text not null check (char_length(category) <= 64),
  count      integer not null default 0,
  usage      numeric(14, 2) not null default 0,
  price_usd  numeric(14, 6) not null default 0,
  synced_at  timestamptz not null default now(),
  primary key (org_id, day, category)
);

-- Every sent email: provider message id, latest status, bounce info. Filled from the send ledger (message_deliveries)
-- and, when configured, a provider event API (SendGrid-style).
create table public.email_tracking (
  org_id        uuid not null references public.organizations (id) on delete cascade,
  message_id    text not null check (char_length(message_id) <= 255),
  delivery_id   uuid,
  provider      text not null default 'ledger' check (char_length(provider) <= 32),
  status        text not null check (char_length(status) <= 32),
  bounce_type   text check (bounce_type is null or char_length(bounce_type) <= 64),
  sent_at       timestamptz,
  last_event_at timestamptz,
  synced_at     timestamptz not null default now(),
  primary key (org_id, message_id)
);

-- Quickvee rewards and order history.
alter table public.customers
  add column rewards_member    boolean not null default false,
  add column rewards_points    integer check (rewards_points is null or rewards_points >= 0),
  add column rewards_joined_at date,
  add column source            text check (source is null or char_length(source) <= 32);
alter table public.purchases
  add column discount_cents  integer not null default 0 check (discount_cents >= 0),
  add column payment_method  text check (payment_method is null or char_length(payment_method) <= 40),
  add column source          text check (source is null or char_length(source) <= 32);
alter table public.purchase_items
  add column category        text check (category is null or char_length(category) <= 100),
  add column brand           text check (brand is null or char_length(brand) <= 100),
  add column discount_cents  integer not null default 0 check (discount_cents >= 0);

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.sync_schedules enable row level security;
alter table public.etl_runs enable row level security;
alter table public.etl_watermarks enable row level security;
alter table public.provider_usage_daily enable row level security;
alter table public.twilio_usage_daily enable row level security;
alter table public.email_tracking enable row level security;

create policy sync_schedules_select on public.sync_schedules for select to authenticated using (public.has_org_role(org_id, '{owner,admin}'));
create policy sync_schedules_insert on public.sync_schedules for insert to authenticated with check (public.has_org_role(org_id, '{owner,admin}'));
create policy sync_schedules_update on public.sync_schedules for update to authenticated
  using (public.has_org_role(org_id, '{owner,admin}')) with check (public.has_org_role(org_id, '{owner,admin}'));
create policy etl_runs_select on public.etl_runs for select to authenticated using (public.has_org_role(org_id, '{owner,admin}'));
create policy etl_watermarks_select on public.etl_watermarks for select to authenticated using (public.has_org_role(org_id, '{owner,admin}'));
create policy provider_usage_daily_select on public.provider_usage_daily for select to authenticated using (public.has_org_role(org_id, '{owner,admin}'));
create policy twilio_usage_daily_select on public.twilio_usage_daily for select to authenticated using (public.has_org_role(org_id, '{owner,admin}'));
create policy email_tracking_select on public.email_tracking for select to authenticated using (public.has_org_role(org_id, '{owner,admin}'));

revoke all on public.sync_schedules, public.etl_runs, public.etl_watermarks, public.provider_usage_daily, public.twilio_usage_daily, public.email_tracking from anon, authenticated;
grant select on public.etl_runs, public.etl_watermarks, public.provider_usage_daily, public.twilio_usage_daily, public.email_tracking to authenticated;
grant select, insert, update on public.sync_schedules to authenticated;
