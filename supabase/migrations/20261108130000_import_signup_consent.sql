-- CSV-imported customers are opted in (texts + email) and 21+ verified at in-store signup.
-- Record that in the consent history as event 'opt_in' / source 'import_signup', written by the importing owner/admin.
alter table public.consent_events drop constraint if exists consent_events_source_check;
alter table public.consent_events add constraint consent_events_source_check
  check (source in ('sms_stop', 'email_unsubscribe', 'manual', 'provider', 'sms_start', 'email_resubscribe', 'reoptin_link', 'store_request', 'import_signup'));

drop policy if exists consent_events_insert on public.consent_events;
create policy consent_events_insert on public.consent_events for insert to authenticated
  with check (public.is_org_member(org_id) and actor_id = auth.uid() and (
    event in ('opt_out', 'reoptin_requested')
    or (event = 'opt_in' and source = 'import_signup' and public.has_org_role(org_id, '{owner,admin}'))));

-- POS-reported lifetime order count (CSV import), shown when purchase history isn't loaded.
alter table public.customers add column lifetime_orders integer check (lifetime_orders is null or lifetime_orders >= 0);
