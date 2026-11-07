-- Smoke-shop domain: customer buying patterns, product brands, age verification, promotions (weekly deals)
-- and per-org outreach settings.

-- ───────────────────── Customer buying patterns ─────────────────────
alter table public.customers
  add column age_verified        boolean not null default false,
  add column favorite_categories text[]  not null default '{}',
  add column favorite_brands     text[]  not null default '{}',
  add column visits_per_month    numeric(5, 2) not null default 0 check (visits_per_month >= 0),
  add column avg_basket_cents    integer not null default 0 check (avg_basket_cents >= 0),
  add column preferred_day       smallint check (preferred_day between 0 and 6),          -- 0 = Monday
  add column preferred_time      text check (preferred_time in ('morning', 'afternoon', 'evening'));
comment on column public.customers.age_verified is 'Staff checked ID and the customer is 21+. Required before any marketing.';

alter table public.products add column brand text check (char_length(brand) <= 100);

-- ───────────────────────── Promotions (deals) ─────────────────────────
-- One row per reusable promotion. `days` places it in the weekly slots; `active` is the on/off switch.
create or replace function public.valid_weekdays(p smallint[]) returns boolean
language sql immutable set search_path = '' as $$
  select cardinality(p) between 1 and 7 and not exists (select 1 from unnest(p) d where d is null or d not between 0 and 6)
$$;

create table public.deals (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations (id) on delete cascade,
  days           smallint[] not null check (public.valid_weekdays(days)),                 -- 0 = Monday
  title          text not null check (char_length(title) between 1 and 80),
  description    text not null default '' check (char_length(description) <= 300),
  discount_type  text not null check (discount_type in ('percent', 'amount', 'bogo', 'freebie')),
  discount_value integer,
  categories     text[] not null default '{}' check (cardinality(categories) <= 20),
  product_ids    uuid[] not null default '{}' check (cardinality(product_ids) <= 50),
  starts_on      date,
  ends_on        date,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  created_by     uuid references auth.users (id) on delete set null,
  unique (org_id, id),
  check (ends_on is null or starts_on is null or ends_on >= starts_on),
  check (case discount_type
           when 'percent' then discount_value between 1 and 100
           when 'amount'  then discount_value between 1 and 100000
           else discount_value is null end)
);
create index deals_org_idx on public.deals (org_id) where active;
create trigger deals_set_updated_at before update on public.deals for each row execute function public.set_updated_at();

alter table public.deals enable row level security;
create policy deals_select on public.deals for select to authenticated using (public.is_org_member(org_id));
create policy deals_insert on public.deals for insert to authenticated with check (public.has_org_role(org_id, '{owner,admin}'));
create policy deals_update on public.deals for update to authenticated
  using (public.has_org_role(org_id, '{owner,admin}')) with check (public.has_org_role(org_id, '{owner,admin}'));
create policy deals_delete on public.deals for delete to authenticated using (public.has_org_role(org_id, '{owner,admin}'));

revoke all on public.deals from anon;
grant select, insert, update, delete on public.deals to authenticated;

-- Drafts remember which deal a suggestion used (for attribution).
alter table public.outreach_drafts add column deal_id uuid,
  add foreign key (org_id, deal_id) references public.deals (org_id, id) on delete set null (deal_id);

-- ───────────────────────── Org settings ─────────────────────────
create table public.org_settings (
  org_id               uuid primary key references public.organizations (id) on delete cascade,
  store_name           text check (char_length(store_name) between 1 and 100),
  email_signature      text not null default '' check (char_length(email_signature) <= 1000),
  sms_signature        text not null default '' check (char_length(sms_signature) <= 60 and sms_signature !~ '[\r\n]'),
  default_channel      public.outreach_channel,
  max_discount_percent smallint not null default 25 check (max_discount_percent between 0 and 100),
  updated_at           timestamptz not null default now(),
  updated_by           uuid references auth.users (id) on delete set null
);
create trigger org_settings_set_updated_at before update on public.org_settings for each row execute function public.set_updated_at();

alter table public.org_settings enable row level security;
create policy org_settings_select on public.org_settings for select to authenticated using (public.is_org_member(org_id));
create policy org_settings_insert on public.org_settings for insert to authenticated with check (public.has_org_role(org_id, '{owner,admin}'));
create policy org_settings_update on public.org_settings for update to authenticated
  using (public.has_org_role(org_id, '{owner,admin}')) with check (public.has_org_role(org_id, '{owner,admin}'));

revoke all on public.org_settings from anon;
grant select, insert, update on public.org_settings to authenticated;
revoke execute on function public.valid_weekdays(smallint[]) from anon;

-- ───────────────────── Per-channel opt-outs (suppressions) ─────────────────────
-- Suppressions were already per (org, channel, contact). Constrain `source` so the opt-out list can show
-- how each one arrived: STOP reply, email unsubscribe link, staff (manual), or a provider bounce/complaint.
update public.suppressions set source = 'manual' where source is null or source not in ('sms_stop', 'email_unsubscribe', 'manual', 'provider');
alter table public.suppressions
  alter column source set default 'manual',
  alter column source set not null,
  add constraint suppressions_source_check check (source in ('sms_stop', 'email_unsubscribe', 'manual', 'provider'));
create index suppressions_org_created_idx on public.suppressions (org_id, created_at desc);

-- ───────────────────────── Replies (conversations) ─────────────────────────
-- One thread per (org, channel, normalized contact). Inbound rows are written by the backend's privileged
-- connection (webhooks); members read threads, mark them read, and send outbound replies as themselves.
create table public.conversations (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations (id) on delete cascade,
  channel         public.outreach_channel not null,
  contact_value   text not null,
  customer_id     uuid,
  unread_count    integer not null default 0 check (unread_count >= 0),
  last_message_at timestamptz not null default now(),
  last_read_at    timestamptz,
  created_at      timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, channel, contact_value),
  check (contact_value = public.normalize_contact(channel, contact_value)),
  foreign key (org_id, customer_id) references public.customers (org_id, id) on delete set null (customer_id)
);
create index conversations_recent_idx on public.conversations (org_id, last_message_at desc);

create table public.messages (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations (id) on delete cascade,
  conversation_id     uuid not null,
  direction           text not null check (direction in ('inbound', 'outbound')),
  kind                text not null default 'message' check (kind in ('message', 'opt_out', 'opt_in', 'help', 'auto')),
  status              text not null check (status in ('received', 'queued', 'sending', 'sent', 'failed')),
  body                text not null check (char_length(body) between 1 and 10000),
  subject             text check (char_length(subject) <= 300),
  sent_by             uuid references auth.users (id) on delete set null,
  delivery_id         uuid,
  reply_token         text unique check (reply_token ~ '^[A-Za-z0-9_-]{20,64}$'),
  provider_message_id text,
  created_at          timestamptz not null default now(),
  foreign key (org_id, conversation_id) references public.conversations (org_id, id) on delete cascade,
  check (direction = 'outbound' or (status = 'received' and sent_by is null and reply_token is null))
);
create index messages_thread_idx on public.messages (org_id, conversation_id, created_at);
create index messages_delivery_idx on public.messages (delivery_id) where delivery_id is not null;

alter table public.conversations enable row level security;
alter table public.messages      enable row level security;
create policy conversations_select on public.conversations for select to authenticated using (public.is_org_member(org_id));
create policy conversations_insert on public.conversations for insert to authenticated with check (public.is_org_member(org_id));
create policy conversations_update on public.conversations for update to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
create policy messages_select on public.messages for select to authenticated using (public.is_org_member(org_id));
-- Members can only add outbound messages as themselves; inbound messages come from the privileged webhook path.
create policy messages_insert on public.messages for insert to authenticated
  with check (public.is_org_member(org_id) and direction = 'outbound' and sent_by = (select auth.uid()));

revoke all on public.conversations, public.messages from anon;
grant select, insert, update on public.conversations to authenticated;
grant select, insert on public.messages to authenticated;
