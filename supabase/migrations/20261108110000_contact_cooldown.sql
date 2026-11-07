-- Contact cooldown: when each customer last got an outreach text / email from the app, and per-org minimum days
-- between sends on each channel. Customers inside both windows (or the only reachable one) drop out of the deck.

alter table public.customers
  add column last_sms_at timestamptz,
  add column last_email_at timestamptz;

alter table public.org_settings
  add column sms_cooldown_days integer not null default 0 check (sms_cooldown_days between 0 and 365),
  add column email_cooldown_days integer not null default 0 check (email_cooldown_days between 0 and 365);

-- Stamp the customer when a delivery is marked sent (the delivery worker's privileged connection writes the status).
create or replace function public.stamp_customer_last_sent() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'sent' and old.status is distinct from 'sent' then
    update public.customers cu set
      last_sms_at   = case when new.channel = 'sms'   then greatest(coalesce(cu.last_sms_at, 'epoch'), now()) else cu.last_sms_at end,
      last_email_at = case when new.channel = 'email' then greatest(coalesce(cu.last_email_at, 'epoch'), now()) else cu.last_email_at end
    from public.outreach_opportunities o
    where o.org_id = new.org_id and o.id = new.opportunity_id and cu.org_id = o.org_id and cu.id = o.customer_id;
  end if;
  return new;
end $$;
revoke all on function public.stamp_customer_last_sent() from public, anon, authenticated;

create trigger message_deliveries_stamp_last_sent after update of status on public.message_deliveries
  for each row execute function public.stamp_customer_last_sent();

-- Signed-in users (RLS role) may not rewrite send history to dodge the cooldown; only the backend/service role can.
create or replace function public.protect_customer_last_sent() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') then
    new.last_sms_at := old.last_sms_at;
    new.last_email_at := old.last_email_at;
  end if;
  return new;
end $$;

create trigger customers_protect_last_sent before update of last_sms_at, last_email_at on public.customers
  for each row execute function public.protect_customer_last_sent();

create index customers_last_sent_idx on public.customers (org_id, last_sms_at, last_email_at);
