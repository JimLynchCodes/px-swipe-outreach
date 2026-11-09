-- Per-org+opportunity+channel AI suggestion cache. Served on later loads until the fingerprint changes
-- (model, brand voice, promotions, signatures, prompt schema). See docs/AI_SUGGESTIONS.md.
create table public.suggestion_cache (
  org_id         uuid not null references public.organizations (id) on delete cascade,
  opportunity_id uuid not null,
  channel        public.outreach_channel not null,
  cache_key      text not null check (char_length(cache_key) between 8 and 64),
  payload        jsonb not null,
  model          text not null default 'rules' check (char_length(model) <= 100),
  source         text not null check (source in ('openai', 'openrouter', 'rules')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (org_id, opportunity_id, channel),
  foreign key (org_id, opportunity_id) references public.outreach_opportunities (org_id, id) on delete cascade
);
create index suggestion_cache_org_updated_idx on public.suggestion_cache (org_id, updated_at desc);

alter table public.suggestion_cache enable row level security;
create policy suggestion_cache_select on public.suggestion_cache for select to authenticated using (public.is_org_member(org_id));
create policy suggestion_cache_insert on public.suggestion_cache for insert to authenticated
  with check (public.is_org_member(org_id));
create policy suggestion_cache_update on public.suggestion_cache for update to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
create policy suggestion_cache_delete on public.suggestion_cache for delete to authenticated using (public.is_org_member(org_id));
revoke all on public.suggestion_cache from anon;
grant select, insert, update, delete on public.suggestion_cache to authenticated;

-- Drafts can come from OpenRouter too (was openai|rules only).
alter table public.outreach_drafts drop constraint if exists outreach_drafts_source_check;
alter table public.outreach_drafts add constraint outreach_drafts_source_check check (source in ('openai', 'openrouter', 'rules'));
