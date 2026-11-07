-- Per-org AI model choice for suggestions. The allowlist lives in code (src/ai/models.ts) and is validated by the API;
-- the column only bounds the shape. "rules" = no AI.
alter table public.org_settings
  add column ai_model text not null default 'gpt-4o-mini'
  check (ai_model ~ '^[a-z0-9][a-z0-9._-]{0,63}$');
