-- PX Swipe Outreach: core multi-tenant schema with row-level security.
-- Supabase CLI layout: apply with `supabase db push` (hosted) or `supabase start`/`supabase db reset` (local).
-- Every tenant-owned table carries org_id; child tables use composite (org_id, id) foreign keys so a row
-- can never reference another organization's data, and RLS restricts every table to org members.

-- ───────────────────────────── Types ─────────────────────────────
create type public.member_role        as enum ('owner', 'admin', 'staff');
create type public.outreach_channel   as enum ('sms', 'email');
create type public.opportunity_status as enum ('pending', 'drafted', 'skipped', 'queued', 'sent', 'failed', 'suppressed');
create type public.delivery_status    as enum ('queued', 'sending', 'sent', 'delivered', 'failed');
create type public.suppression_reason as enum ('opt_out', 'bounce', 'complaint', 'manual');

-- ─────────────────────────── Helpers ────────────────────────────
create or replace function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Canonical form used for suppression matching: E.164-ish digits for SMS, lower-case for email.
create or replace function public.normalize_contact(p_channel public.outreach_channel, p_value text) returns text
language sql immutable set search_path = '' as $$
  select case p_channel
    when 'sms'   then nullif('+' || regexp_replace(coalesce(p_value, ''), '\D', '', 'g'), '+')
    when 'email' then nullif(lower(btrim(coalesce(p_value, ''))), '')
  end
$$;

-- ───────────────────── Organizations & members ────────────────────
create table public.organizations (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (char_length(name) between 1 and 200),
  slug          text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  business_name text check (char_length(business_name) <= 200),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references auth.users (id) on delete set null
);

create table public.memberships (
  org_id     uuid not null references public.organizations (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       public.member_role not null default 'staff',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  primary key (org_id, user_id)
);
create index memberships_user_idx on public.memberships (user_id);

-- SECURITY DEFINER so policies on memberships can call them without recursing through RLS.
create or replace function public.is_org_member(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = p_org and m.user_id = (select auth.uid())
  )
$$;

create or replace function public.has_org_role(p_org uuid, p_roles public.member_role[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = p_org and m.user_id = (select auth.uid()) and m.role = any (p_roles)
  )
$$;

-- Self-service org creation: the caller becomes its owner.
create or replace function public.create_organization(p_name text, p_slug text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := (select auth.uid());
  v_org  uuid;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  insert into public.organizations (name, slug, created_by) values (p_name, p_slug, v_user) returning id into v_org;
  insert into public.memberships (org_id, user_id, role, created_by) values (v_org, v_user, 'owner', v_user);
  return v_org;
end $$;

-- ───────────────────────── Retail data ──────────────────────────
create table public.stores (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 200),
  location   text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, name)
);

create table public.customers (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.organizations (id) on delete cascade,
  external_id          text,                        -- POS identifier
  first_name           text not null check (char_length(first_name) between 1 and 100),
  last_name            text not null default '' check (char_length(last_name) <= 100),
  age                  smallint check (age between 0 and 130),
  gender               text check (char_length(gender) <= 50),
  location             text check (char_length(location) <= 200),
  phone                text check (char_length(phone) <= 32),
  email                text check (char_length(email) <= 320),
  sms_consent          boolean not null default false,
  email_consent        boolean not null default false,
  lifetime_spend_cents bigint not null default 0 check (lifetime_spend_cents >= 0),
  last_purchase_at     timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, external_id)
);

create table public.products (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  external_id text,
  sku         text,
  name        text not null check (char_length(name) between 1 and 200),
  category    text,
  price_cents integer not null default 0 check (price_cents >= 0),
  image_url   text check (image_url ~ '^https://'),
  in_stock    boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, external_id)
);

create table public.purchases (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  customer_id  uuid not null,
  store_id     uuid,
  external_id  text,
  purchased_at timestamptz not null,
  total_cents  bigint not null default 0 check (total_cents >= 0),
  created_at   timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, external_id),
  foreign key (org_id, customer_id) references public.customers (org_id, id) on delete cascade,
  foreign key (org_id, store_id) references public.stores (org_id, id)
);

create table public.purchase_items (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations (id) on delete cascade,
  purchase_id      uuid not null,
  product_id       uuid,
  product_name     text not null,
  quantity         integer not null default 1 check (quantity > 0),
  unit_price_cents integer not null default 0 check (unit_price_cents >= 0),
  foreign key (org_id, purchase_id) references public.purchases (org_id, id) on delete cascade,
  foreign key (org_id, product_id) references public.products (org_id, id)
);

-- ─────────────────────── Campaigns & offers ───────────────────────
create table public.campaigns (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations (id) on delete cascade,
  key        text not null,                      -- e.g. 'winback'
  name       text not null,
  type       text not null check (type in ('win_back', 'vip_thanks', 'nurture', 'custom')),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, key)
);

create table public.offers (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations (id) on delete cascade,
  code             text not null,
  name             text not null,
  discount_percent smallint not null check (discount_percent between 0 and 100),
  combinable       boolean not null default false,
  active           boolean not null default true,
  starts_at        timestamptz,
  ends_at          timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, code),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);

-- ─────────────────────────── Outreach ───────────────────────────
create table public.outreach_opportunities (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  customer_id uuid not null,
  campaign_id uuid not null,
  offer_id    uuid,
  score       numeric(6, 3) not null default 0,
  rationale   text not null,
  status      public.opportunity_status not null default 'pending',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users (id) on delete set null,
  unique (org_id, id),
  foreign key (org_id, customer_id) references public.customers (org_id, id) on delete cascade,
  foreign key (org_id, campaign_id) references public.campaigns (org_id, id),
  foreign key (org_id, offer_id) references public.offers (org_id, id)
);
create index opportunities_queue_idx on public.outreach_opportunities (org_id, created_at)
  where status in ('pending', 'drafted');
create index opportunities_customer_idx on public.outreach_opportunities (org_id, customer_id);

create table public.outreach_drafts (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations (id) on delete cascade,
  opportunity_id uuid not null,
  channel        public.outreach_channel not null,
  title          text,
  message        text not null,
  subject        text,
  rationale      text not null,
  source         text not null check (source in ('openai', 'rules')),
  created_at     timestamptz not null default now(),
  created_by     uuid references auth.users (id) on delete set null,
  foreign key (org_id, opportunity_id) references public.outreach_opportunities (org_id, id) on delete cascade
);
create index drafts_opportunity_idx on public.outreach_drafts (org_id, opportunity_id, created_at desc);

create table public.message_deliveries (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations (id) on delete cascade,
  opportunity_id      uuid not null,
  channel             public.outreach_channel not null,
  recipient           text not null,
  message             text not null check (char_length(message) between 1 and 5000),
  subject             text check (char_length(subject) <= 200),
  status              public.delivery_status not null default 'queued',
  provider_message_id text,
  error               text,
  idempotency_key     text not null check (char_length(idempotency_key) between 8 and 200),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid references auth.users (id) on delete set null,
  unique (org_id, idempotency_key),
  foreign key (org_id, opportunity_id) references public.outreach_opportunities (org_id, id) on delete cascade
);
-- At most one live (non-failed) delivery per opportunity: a customer is never double-messaged.
create unique index deliveries_one_live_per_opportunity on public.message_deliveries (opportunity_id)
  where status <> 'failed';
create index deliveries_opportunity_idx on public.message_deliveries (org_id, opportunity_id, created_at desc);
create index deliveries_status_idx on public.message_deliveries (org_id, status, channel);

-- Append-only audit trail.
create table public.outreach_events (
  id             bigint generated always as identity primary key,
  org_id         uuid not null references public.organizations (id) on delete cascade,
  opportunity_id uuid,
  actor_id       uuid references auth.users (id) on delete set null,   -- null = system
  event_type     text not null,
  details        jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  foreign key (org_id, opportunity_id) references public.outreach_opportunities (org_id, id) on delete cascade
);
create index events_opportunity_idx on public.outreach_events (org_id, opportunity_id, created_at desc);

-- Do-not-contact list. Matched on the normalized contact value, so it survives customer re-imports.
create table public.suppressions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  channel     public.outreach_channel not null,
  value       text not null,
  reason      public.suppression_reason not null default 'opt_out',
  source      text,                                 -- e.g. 'staff', 'sms_stop', 'provider_webhook'
  customer_id uuid,
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users (id) on delete set null,
  unique (org_id, channel, value),
  check (value = public.normalize_contact(channel, value)),
  foreign key (org_id, customer_id) references public.customers (org_id, id) on delete set null (customer_id)
);

-- Defense in depth: the database itself refuses to queue a message to a suppressed recipient.
create or replace function public.enforce_not_suppressed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from public.suppressions s
    where s.org_id = new.org_id and s.channel = new.channel
      and s.value = public.normalize_contact(new.channel, new.recipient)
  ) then
    raise exception 'recipient_suppressed' using errcode = 'P0001', hint = 'Recipient is on the suppression list';
  end if;
  return new;
end $$;

create trigger message_deliveries_not_suppressed
  before insert on public.message_deliveries
  for each row execute function public.enforce_not_suppressed();

-- updated_at maintenance
do $$
declare t text;
begin
  foreach t in array array['organizations', 'memberships', 'stores', 'customers', 'products', 'campaigns',
                           'offers', 'outreach_opportunities', 'message_deliveries'] loop
    execute format('create trigger %I before update on public.%I for each row execute function public.set_updated_at()',
                   t || '_set_updated_at', t);
  end loop;
end $$;

-- ───────────────────────── Row-level security ─────────────────────────
alter table public.organizations          enable row level security;
alter table public.memberships            enable row level security;
alter table public.stores                 enable row level security;
alter table public.customers              enable row level security;
alter table public.products               enable row level security;
alter table public.purchases              enable row level security;
alter table public.purchase_items         enable row level security;
alter table public.campaigns              enable row level security;
alter table public.offers                 enable row level security;
alter table public.outreach_opportunities enable row level security;
alter table public.outreach_drafts        enable row level security;
alter table public.message_deliveries     enable row level security;
alter table public.outreach_events        enable row level security;
alter table public.suppressions           enable row level security;

-- Organizations: members read; owners/admins update; owners delete. Creation goes through create_organization().
create policy org_select on public.organizations for select to authenticated using (public.is_org_member(id));
create policy org_update on public.organizations for update to authenticated
  using (public.has_org_role(id, '{owner,admin}')) with check (public.has_org_role(id, '{owner,admin}'));
create policy org_delete on public.organizations for delete to authenticated using (public.has_org_role(id, '{owner}'));

-- Memberships: members see their org's roster; owners/admins manage it; only owners grant/hold 'owner'.
create policy membership_select on public.memberships for select to authenticated using (public.is_org_member(org_id));
create policy membership_insert on public.memberships for insert to authenticated
  with check (public.has_org_role(org_id, '{owner,admin}') and (role <> 'owner' or public.has_org_role(org_id, '{owner}')));
create policy membership_update on public.memberships for update to authenticated
  using (public.has_org_role(org_id, '{owner,admin}') and (role <> 'owner' or public.has_org_role(org_id, '{owner}')))
  with check (public.has_org_role(org_id, '{owner,admin}') and (role <> 'owner' or public.has_org_role(org_id, '{owner}')));
create policy membership_delete on public.memberships for delete to authenticated
  using (user_id = (select auth.uid())
         or (public.has_org_role(org_id, '{owner,admin}') and (role <> 'owner' or public.has_org_role(org_id, '{owner}'))));

-- Reference/POS data: every member reads; owners/admins write (POS sync normally uses the service role).
do $$
declare t text;
begin
  foreach t in array array['stores', 'customers', 'products', 'purchases', 'purchase_items', 'campaigns', 'offers'] loop
    execute format('create policy %I on public.%I for select to authenticated using (public.is_org_member(org_id))', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.has_org_role(org_id, ''{owner,admin}''))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.has_org_role(org_id, ''{owner,admin}'')) with check (public.has_org_role(org_id, ''{owner,admin}''))', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.has_org_role(org_id, ''{owner,admin}''))', t || '_delete', t);
  end loop;
end $$;

-- Opportunities: members read and move them through the workflow; admins create/delete.
create policy opp_select on public.outreach_opportunities for select to authenticated using (public.is_org_member(org_id));
create policy opp_update on public.outreach_opportunities for update to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
create policy opp_insert on public.outreach_opportunities for insert to authenticated with check (public.has_org_role(org_id, '{owner,admin}'));
create policy opp_delete on public.outreach_opportunities for delete to authenticated using (public.has_org_role(org_id, '{owner,admin}'));

-- Drafts, deliveries, events: members read; members insert as themselves. Delivery status updates
-- (sending/sent/failed) are written only by the backend's privileged connection or the worker.
create policy drafts_select on public.outreach_drafts for select to authenticated using (public.is_org_member(org_id));
create policy drafts_insert on public.outreach_drafts for insert to authenticated
  with check (public.is_org_member(org_id) and created_by = (select auth.uid()));

create policy deliveries_select on public.message_deliveries for select to authenticated using (public.is_org_member(org_id));
create policy deliveries_insert on public.message_deliveries for insert to authenticated
  with check (public.is_org_member(org_id) and created_by = (select auth.uid()) and status = 'queued');

create policy events_select on public.outreach_events for select to authenticated using (public.is_org_member(org_id));
create policy events_insert on public.outreach_events for insert to authenticated
  with check (public.is_org_member(org_id) and actor_id = (select auth.uid()));

-- Suppressions: any member can record an opt-out; only owners/admins can remove one.
create policy suppressions_select on public.suppressions for select to authenticated using (public.is_org_member(org_id));
create policy suppressions_insert on public.suppressions for insert to authenticated
  with check (public.is_org_member(org_id) and created_by = (select auth.uid()));
create policy suppressions_delete on public.suppressions for delete to authenticated using (public.has_org_role(org_id, '{owner,admin}'));

-- ───────────────────────────── Grants ─────────────────────────────
-- The anon role gets nothing. authenticated gets table privileges, constrained by the policies above.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
revoke update, delete on public.outreach_events from authenticated;   -- audit log is append-only

revoke execute on function public.is_org_member(uuid), public.has_org_role(uuid, public.member_role[]),
  public.create_organization(text, text), public.enforce_not_suppressed() from public, anon;
grant execute on function public.is_org_member(uuid), public.has_org_role(uuid, public.member_role[]),
  public.create_organization(text, text) to authenticated;
