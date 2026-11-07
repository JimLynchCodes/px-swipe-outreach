-- CSV customer import + Registered users page.
-- Imports run as the signed-in owner/admin through the existing customers/opportunities RLS (insert = owner/admin).
-- Opening a specific customer's card is allowed for any member via a narrowly scoped security-definer function.

create index if not exists customers_org_created_idx on public.customers (org_id, created_at desc);
-- Dedupe lookups (phone last-10 digits, lowercased email).
create index if not exists customers_org_phone10_idx on public.customers (org_id, right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 10));
create index if not exists customers_org_email_idx on public.customers (org_id, lower(email));

/** The 'manual' campaign used by imports and explicit picks (created on first use). */
create or replace function public.manual_campaign_id(p_org uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  if not public.is_org_member(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  insert into public.campaigns (org_id, key, name, type) values (p_org, 'manual', 'Manual outreach', 'custom')
    on conflict (org_id, key) do nothing;
  select id into v from public.campaigns where org_id = p_org and key = 'manual';
  return v;
end $$;

/**
 * Returns the customer's actionable (pending/drafted) opportunity, creating a pending one when there is none.
 * Any member may call it (staff work the deck); it can only touch the caller's own org. Null = unknown customer.
 */
create or replace function public.open_customer_card(p_org uuid, p_customer uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  if not public.is_org_member(p_org) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.customers where org_id = p_org and id = p_customer) then return null; end if;
  select id into v from public.outreach_opportunities
    where org_id = p_org and customer_id = p_customer and status in ('pending', 'drafted') order by created_at desc limit 1;
  if v is null then
    insert into public.outreach_opportunities (org_id, customer_id, campaign_id, score, rationale, status)
      values (p_org, p_customer, public.manual_campaign_id(p_org), 50, 'Picked from Registered users', 'pending') returning id into v;
  end if;
  return v;
end $$;

revoke all on function public.manual_campaign_id(uuid) from public, anon;
revoke all on function public.open_customer_card(uuid, uuid) from public, anon;
grant execute on function public.manual_campaign_id(uuid), public.open_customer_card(uuid, uuid) to authenticated;
