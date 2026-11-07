-- Per-SMS provider cost (Twilio spend on the Cost metrics page). One row per outbound SMS.
-- Written only by the backend's privileged connection (send path, Twilio status callback, reconcile job);
-- readable by org owners/admins (costs are management-only, like ai_usage).
create table public.sms_costs (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  provider     text not null check (provider in ('log', 'twilio')),
  message_sid  text unique check (message_sid is null or char_length(message_sid) <= 64),
  segments     integer not null default 1 check (segments between 1 and 20),
  -- USD, positive (Twilio reports prices as negative strings; we store the absolute value).
  price_usd    numeric(12, 6) not null default 0 check (price_usd >= 0),
  -- true until Twilio reports the actual price (status callback or reconcile job).
  estimated    boolean not null default false,
  status       text check (status is null or char_length(status) <= 32),
  is_demo      boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index sms_costs_org_created_idx on public.sms_costs (org_id, created_at desc);
create index sms_costs_pending_idx on public.sms_costs (created_at) where estimated and provider = 'twilio';

alter table public.sms_costs enable row level security;
create policy sms_costs_select on public.sms_costs for select to authenticated using (public.has_org_role(org_id, '{owner,admin}'));
revoke all on public.sms_costs from anon, authenticated;
grant select on public.sms_costs to authenticated;
