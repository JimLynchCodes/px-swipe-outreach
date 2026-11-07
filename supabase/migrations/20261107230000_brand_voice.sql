-- Brand voice for AI copy: { preset: friendly|chill|premium, emoji: bool, signOff: text, about: text }.
alter table public.org_settings add column brand_voice jsonb not null
  default '{"preset":"friendly","emoji":false,"signOff":"","about":""}'::jsonb
  check (jsonb_typeof(brand_voice) = 'object'
         and brand_voice ->> 'preset' in ('friendly', 'chill', 'premium')
         and char_length(coalesce(brand_voice ->> 'about', '')) <= 500
         and char_length(coalesce(brand_voice ->> 'signOff', '')) <= 40);
