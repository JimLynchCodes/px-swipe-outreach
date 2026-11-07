-- OpenRouter as the default AI provider: model ids are vendor-namespaced ("openai/gpt-4o-mini"), and ai_usage rows can
-- come from the openrouter provider (cost_usd then is OpenRouter's reported cost, price_version = 'provider-reported').
alter table public.org_settings drop constraint if exists org_settings_ai_model_check;
alter table public.org_settings add constraint org_settings_ai_model_check check (ai_model ~ '^[a-z0-9][a-z0-9._:/-]{0,99}$');
alter table public.org_settings alter column ai_model set default 'openai/gpt-4o-mini';

alter table public.ai_usage drop constraint if exists ai_usage_provider_check;
alter table public.ai_usage add constraint ai_usage_provider_check check (provider in ('rules', 'openai', 'openrouter', 'anthropic'));
alter table public.ai_usage drop constraint if exists ai_usage_model_check;
alter table public.ai_usage add constraint ai_usage_model_check check (char_length(model) <= 100);
