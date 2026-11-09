# AI suggestions (OpenRouter, with direct OpenAI as an optional fallback)

Set `OPENROUTER_API_KEY` on the backend and pick a model under **Settings → Model**. With no key, or with the model set to **None**, suggestions come from the rules engine at no cost.

## Providers

| Env | Effect |
| --- | --- |
| `OPENROUTER_API_KEY` | Enables OpenRouter (`https://openrouter.ai/api/v1`, OpenAI-compatible, sends `HTTP-Referer: APP_URL` and `X-Title: OPENROUTER_APP_NAME`). It's the default provider when set. |
| `OPENAI_API_KEY` | Enables direct OpenAI. Optional; when both keys are set, it's the fallback. |
| `AI_PROVIDER=openrouter\|openai` | Forces the primary provider. Startup fails if that provider's key is missing, or if `OPENAI_MODEL` isn't on the allowlist. |

**Models** (`src/ai/models.ts`) use OpenRouter ids. The default is `openai/gpt-4o-mini`; the cheap options are `google/gemini-2.5-flash-lite`, `anthropic/claude-haiku-5.5`, `mistralai/mistral-small-3.2-24b-instruct`, `deepseek/deepseek-chat-v3.1`, `openai/gpt-5-mini` and `openai/gpt-4.1-mini`. All were checked against `GET /api/v1/models` (Nov 2026) and support `structured_outputs`. The direct OpenAI ids (`gpt-4o-mini`, ...) are still listed as "(direct OpenAI)". `openai/*` models and their direct ids are aliases, so an org that saved `gpt-4o-mini` keeps working through OpenRouter, and an `openai/*` choice can fall back to direct OpenAI. **None** (rules) is always available.

**Routing and fallback.** The org's model goes to the primary provider. If that call errors, it goes to the other provider (if keyed and the model has an alias there), then to rules. A compliance rejection is not retried on another provider. It regenerates once, then uses rules.

**Structured outputs only.** Requests send a strict `json_schema` plus `provider: { require_parameters: true }`, so OpenRouter only routes to upstreams that honor it. Output is re-validated with zod.

**Prices.** When an OpenRouter key is set, the server refreshes `/api/v1/models` every 6h (cached 24h). This updates per-token prices for allowlisted models only, and hides any allowlisted model that has lost `structured_outputs`. The static table is the fallback.

**Cost accounting.** OpenRouter requests send `usage: { include: true }`, and `usage.cost` (USD) is recorded in `ai_usage.cost_usd` with `price_version = 'provider-reported'`. If it's missing, the server looks up `GET /api/v1/generation?id=` (`total_cost`). If that fails too, it uses the static price table (`price_version` = the table date). Wasted spend on rejected attempts is recorded too.

## How a suggestion is generated

1. **Promotions offered to the model.** These are the org's promotions that are enabled, run in the next 7 days, and fall within the **Max discount** cap (`eligiblePromotions`). Disabled, expired and over-cap promotions are never shown to the model.
2. **Prompt** (`retail-outreach-backend/src/ai/prompt.ts`, `PROMPT_VERSION`):
   - **System prompt (compact):** store identity, brand voice, hard compliance rules, SMS/email budgets, and **one** few-shot for the customer's segment only (not all three).
   - **User payload (JSON, trimmed):** first name, segment, days since visit, visit cadence, preferred day/time, top 3 recent items, top categories/brands from purchases, restock hints, rewards points (if any); compact promotions (id, title, discount, schedule, cats); engine pick id; standing offer; cap. Last name, phone, email and address are never sent.
3. **Structured output.** A strict JSON schema, validated again with zod:
   `{ promotion_id | null, reason, send_time, sms_text, email_subject, email_body, confidence }`.
4. **Request settings.** Temperature 0.3 (left out for reasoning models), `max_completion_tokens` 350, a 15 s timeout, and 2 SDK retries with exponential backoff on 429, 5xx and connection errors.
5. **Compliance validator** (`src/ai/compliance.ts`). It checks the copy after generation. If the draft is rejected, it is **regenerated once**, with the violations fed back to the model. If the second draft also fails, or the call errors or times out, the suggestion **falls back to the rules engine**.
6. **Cost metrics.** Every call is recorded. A fallback records two rows: the tokens spent on the failed AI attempt (priced), and the rules call (free).


## When AI runs (and when it doesn't)

Suggestions are **cached per org + opportunity + channel** under a fingerprint of the model, brand voice, discount cap, signatures, store name, and eligible promotions (`src/ai/cache.ts`, `CACHE_SCHEMA`).

| Event | AI call? |
| --- | --- |
| Generating a new deck (`POST /api/outreach/deck/prepare`) | Yes, only for cards missing a matching cache entry (parallel, concurrency 4) |
| Opening a card / swiping / revisiting the deck | **No** — cache hit |
| Page navigation, re-render, remount | **No** |
| Settings / brand voice / model / promotions change (fingerprint changes) or `refresh: true` (Retry, model picker, deals panel) | Yes — regenerate that card |
| Explicit pick from Registered users | Yes if uncached (cooldown ignored for the pick) |

Demo mode keeps the cache in memory (`MemoryStore`). Supabase mode uses the `suggestion_cache` table (migration `20261109170000_suggestion_cache.sql`). Cost metrics (`ai_usage`) are recorded **only when a new suggestion is generated**, not on cache hits. Failed AI attempts before a rules fallback are still recorded.

**Prompt caching.** OpenRouter requests mark the system prompt with `cache_control: { type: "ephemeral" }` (honored by Anthropic-routed models). OpenAI caches long identical prefixes automatically on supported models. Reusing the same system text across a deck's cards is what makes that pay off.

### Rough token estimates per deck (20 cards, gpt-4o-mini / comparable)

| | Input (uncached) | Input (with prompt cache) | Output |
| --- | --- | --- | --- |
| Per card | ~700–900 tokens (system ~450 + user ~250–400) | ~250–400 new tokens (user only; system cached) | ~120–180 tokens |
| Full new deck (20) | ~14–18k input + ~2.5–3.5k output | ~5–8k new input after the first card warms the cache | ~2.5–3.5k |
| Revisiting the same deck | **0** (served from `suggestion_cache`) | — | — |

At gpt-4o-mini list prices that's on the order of **$0.003–$0.006 per fresh 20-card deck**, and **$0** to open it again until something invalidates the fingerprint.

## Brand voice (Settings → Brand voice)

| Field | Values |
|---|---|
| Voice | Friendly local shop / Chill / Premium lounge |
| Allow emoji | off by default; emoji make an SMS UCS-2, which allows only 70 characters per segment |
| Email sign-off | single line, ≤40 characters |
| About our shop | ≤500 characters of facts the model may use; it is told not to invent anything beyond them |

The voice is stored in `org_settings.brand_voice` (migration `20261107230000_brand_voice.sql`).

## Compliance guardrails

These are enforced both in the prompt and by the validator.

| Rule | Validator code |
|---|---|
| No health or medical claims (e.g. "CBD helps anxiety/sleep/pain", "therapeutic") | `health_claim` |
| No claims that a product is safe, safer or healthier, and no "quit smoking" | `safety_claim` |
| Nothing appealing to minors (school, teens, cartoons, candy, toys…) | `youth_appeal` |
| No free tobacco/nicotine products, samples or giveaways | `free_tobacco` |
| No "get high", "stoned" or similar language | `intoxication` |
| No invented deals: every `N%`, `$N off` or BOGO must match the chosen promotion (or the standing offer) | `invented_discount`, `ungrounded`, `unknown_promotion` |
| No discount above the org cap | `over_cap` |
| No fake urgency ("hurry", "last chance", "limited time"); a real end date within 2 days may be mentioned | `fake_urgency` |
| First name present; last name never used | `no_name`, `last_name` |
| SMS ≤160 characters **including** the signature and "Reply STOP to opt out." (both appended by the app); a non-GSM-7 character produces a warning | `sms_too_long` |
| Email subject ≤50 characters; body ≤700 characters | `subject_too_long`, `body_too_long` |

> These are reasonable defaults for a US smoke shop. **They are not legal advice.** Tobacco, vape, CBD and hemp marketing rules vary by state and channel (FDA, FTC, TCPA/CTIA, carrier policies). Have counsel review your program.

The rules-engine copy, which is the fallback, is unchanged. It can run past 160 characters and then sends as a multi-part SMS.

## Evals

```bash
cd retail-outreach-backend
npm run eval                               # recorded outputs; deterministic, no network (also runs in CI via vitest)
OPENROUTER_API_KEY=sk-or-... npm run eval -- --live            # live, configured provider (AI_PROVIDER rules apply); --model picks one
OPENAI_API_KEY=sk-... npm run eval -- --live                   # live via direct OpenAI; prints tokens + cost
OPENAI_API_KEY=sk-... npm run eval -- --live --judge           # + LLM-as-judge: tone/relevance/persuasiveness 1-5
OPENAI_API_KEY=sk-... npm run eval -- --live --record          # overwrite src/ai/evals/recorded.json
#   --model gpt-4.1-mini   --judge-model gpt-4o-mini   --limit 5
```

- **Fixtures** (`src/ai/evals/fixtures.ts`): the 19 age-verified seed customers (SMS), plus 4 email cases. That gives 23 cases across the loyal, at-risk and lapsed segments.
- **Promotion set:** the seeded weekly promotions, one of which is disabled; a seasonal "Winter Warm-Up" at 20%; and a "Mega Glass Blowout" at 40%, which is over the 25% cap and must never be offered.
- **Each case is checked** through the real provider path (schema, validator, regeneration, fallback) for:
  - compliant final copy;
  - a relevant promotion, meaning it matches the customer's favorite categories, or `none` when nothing fits;
  - SMS length including the signature and opt-out, and GSM-7;
  - subject length;
  - tokens and cost.
- The script exits non-zero if any final copy is non-compliant.

**About the recorded outputs:** `recorded.json` is currently **synthetic**. The outputs were hand-authored in the model's output shape because no API key was available. Five cases deliberately include a bad first draft: a health claim, an over-cap discount, an over-long SMS, an unknown promotion id, and urgency twice in a row, which forces the rules fallback. The recorded run therefore tests the pipeline, not model quality. To measure real quality, run `--live --record`.
