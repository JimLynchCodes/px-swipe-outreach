-- Seasonal & ongoing promotions: a promotion is either weekly (runs on `days`) or a date range
-- (runs every day from starts_on to ends_on). Range promotions store all seven days so the same
-- "does it run on day X within its window" check applies to both.
alter table public.deals
  add column schedule text not null default 'weekly',
  add constraint deals_schedule_check check (schedule in ('weekly', 'range')),
  add constraint deals_range_dates_check check (
    schedule = 'weekly' or (starts_on is not null and ends_on is not null and cardinality(days) = 7)
  );
create index deals_org_range_idx on public.deals (org_id, ends_on) where schedule = 'range' and active;
