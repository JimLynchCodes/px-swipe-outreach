-- Consent history + re-opt-in requests.
--
-- consent_events: append-only log of every opt-out, re-opt-in and re-opt-in request, per (org, channel, contact).
--   Written only by the backend's privileged connection (webhooks, public unsubscribe pages) or by members acting
--   as themselves (manual opt-out, re-opt-in request). Members can read their org's history.
-- reoptin_requests: one "would you like to hear from us again?" request per contact; at most one per 30 days and
--   never while one is pending. Created by owners/admins only.
-- Opt-outs can no longer be deleted by any signed-in user (staff, admin or owner): lifting one requires the
-- customer's own action (START/JOIN reply, resubscribe button, or a re-opt-in confirmation link).

alter table public.suppressions drop constraint if exists suppressions_source_check;
alter table public.suppressions add constraint suppressions_source_check
  check (source in ('sms_stop', 'email_unsubscribe', 'manual', 'provider'));
drop policy if exists suppressions_delete on public.suppressions;
revoke delete on public.suppressions from authenticated;

create table public.consent_events (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  channel     public.outreach_channel not null,
  value       text not null,
  event       text not null check (event in ('opt_out', 'opt_in', 'reoptin_requested')),
  source      text not null check (source in ('sms_stop', 'email_unsubscribe', 'manual', 'provider',
                                              'sms_start', 'email_resubscribe', 'reoptin_link', 'store_request')),
  actor_id    uuid references auth.users (id) on delete set null,
  request_id  text check (char_length(request_id) <= 100),
  created_at  timestamptz not null default now()
);
create index consent_events_contact_idx on public.consent_events (org_id, channel, value, created_at desc);

alter table public.consent_events enable row level security;
create policy consent_events_select on public.consent_events for select to authenticated using (public.is_org_member(org_id));
create policy consent_events_insert on public.consent_events for insert to authenticated
  with check (public.is_org_member(org_id) and actor_id = auth.uid() and event in ('opt_out', 'reoptin_requested'));
revoke all on public.consent_events from anon;
grant select, insert on public.consent_events to authenticated;

-- Append-only, even for the privileged role (rows only go away when their organization is deleted).
create or replace function public.consent_events_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.organizations where id = old.org_id) then return old; end if;
  raise exception 'consent_events is append-only';
end $$;
create trigger consent_events_no_update before update or delete on public.consent_events
  for each row execute function public.consent_events_immutable();

create table public.reoptin_requests (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations (id) on delete cascade,
  channel       public.outreach_channel not null,
  value         text not null,
  customer_id   uuid,
  requested_by  uuid not null references auth.users (id) on delete cascade,
  status        text not null default 'pending' check (status in ('pending', 'confirmed', 'cancelled')),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '30 days',
  confirmed_at  timestamptz
);
create index reoptin_requests_contact_idx on public.reoptin_requests (org_id, channel, value, created_at desc);
-- At most one pending request per contact (the 30-day cooldown is enforced in the API too).
create unique index reoptin_requests_one_pending on public.reoptin_requests (org_id, channel, value) where status = 'pending';

alter table public.reoptin_requests enable row level security;
create policy reoptin_select on public.reoptin_requests for select to authenticated using (public.is_org_member(org_id));
create policy reoptin_insert on public.reoptin_requests for insert to authenticated
  with check (public.has_org_role(org_id, '{owner,admin}') and requested_by = auth.uid() and status = 'pending');
create policy reoptin_update on public.reoptin_requests for update to authenticated
  using (public.has_org_role(org_id, '{owner,admin}')) with check (public.has_org_role(org_id, '{owner,admin}') and status in ('pending', 'cancelled'));
revoke all on public.reoptin_requests from anon;
grant select, insert, update on public.reoptin_requests to authenticated;
