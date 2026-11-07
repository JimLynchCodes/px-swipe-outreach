-- AI usage (cost metrics) and the outreach send ledger (performance metrics / attribution).
-- is_demo marks generated demo rows (seed) so they can be labelled in the UI and removed later.

create table public.ai_usage (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations (id) on delete cascade,
  opportunity_id uuid,
  actor_id       uuid references auth.users (id) on delete set null,
  model          text not null check (char_length(model) <= 64),
  provider       text not null check (provider in ('rules', 'openai', 'anthropic')),
  input_tokens   integer not null default 0 check (input_tokens >= 0),
  output_tokens  integer not null default 0 check (output_tokens >= 0),
  cost_usd       numeric(14, 8) not null default 0 check (cost_usd >= 0),
  price_version  text not null,
  deal_id        uuid,
  deal_title     text,
  led_to_send    boolean not null default false,
  sent_channel   public.outreach_channel,
  is_demo        boolean not null default false,
  created_at     timestamptz not null default now()
);
create index ai_usage_org_created_idx on public.ai_usage (org_id, created_at desc);
create index ai_usage_opp_idx on public.ai_usage (org_id, opportunity_id, created_at desc);

alter table public.ai_usage enable row level security;
-- Costs are management-only; any member's suggestion call is recorded as themselves.
create policy ai_usage_select on public.ai_usage for select to authenticated using (public.has_org_role(org_id, '{owner,admin}'));
create policy ai_usage_insert on public.ai_usage for insert to authenticated
  with check (public.is_org_member(org_id) and actor_id = auth.uid() and not is_demo);
revoke all on public.ai_usage from anon;
grant select, insert on public.ai_usage to authenticated;

-- Members can't read ai_usage, so marking "led to a send" goes through this narrow definer function: it only flips
-- led_to_send/sent_channel on the caller's org's latest row for that opportunity and returns what the send ledger needs.
create function public.mark_ai_usage_sent(p_org uuid, p_opportunity uuid, p_channel public.outreach_channel)
returns table (model text, deal_id uuid, deal_title text)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_org_member(p_org) then raise exception 'not a member' using errcode = '42501'; end if;
  return query
    update public.ai_usage u set led_to_send = true, sent_channel = p_channel
    where u.id = (select a.id from public.ai_usage a where a.org_id = p_org and a.opportunity_id = p_opportunity order by a.created_at desc limit 1)
    returning u.model, u.deal_id, u.deal_title;
end $$;
revoke all on function public.mark_ai_usage_sent(uuid, uuid, public.outreach_channel) from public, anon;
grant execute on function public.mark_ai_usage_sent(uuid, uuid, public.outreach_channel) to authenticated;

create table public.outreach_sends (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations (id) on delete cascade,
  delivery_id      uuid,
  user_id          uuid references auth.users (id) on delete set null,
  user_label       text not null check (char_length(user_label) <= 100),
  customer_id      uuid not null,
  channel          public.outreach_channel not null,
  deal_id          uuid,
  deal_title       text,
  deal_categories  text[] not null default '{}',
  deal_product_ids uuid[] not null default '{}',
  model            text not null default 'rules',
  is_demo          boolean not null default false,
  created_at       timestamptz not null default now(),
  foreign key (org_id, customer_id) references public.customers (org_id, id) on delete cascade
);
create index outreach_sends_org_created_idx on public.outreach_sends (org_id, created_at desc);
create index outreach_sends_customer_idx on public.outreach_sends (org_id, customer_id, created_at);

alter table public.outreach_sends enable row level security;
create policy outreach_sends_select on public.outreach_sends for select to authenticated using (public.is_org_member(org_id));
create policy outreach_sends_insert on public.outreach_sends for insert to authenticated
  with check (public.is_org_member(org_id) and user_id = auth.uid() and not is_demo);
revoke all on public.outreach_sends from anon;
grant select, insert on public.outreach_sends to authenticated;

alter table public.purchases add column is_demo boolean not null default false;
