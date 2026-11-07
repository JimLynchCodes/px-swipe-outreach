# AI suggestions (OpenAI provider)

Set `OPENAI_API_KEY` on the backend and pick a model under **Settings → Model**. With no key, or with the model set to **None**, suggestions come from the rules engine at no cost.

## How a suggestion is generated

1. **Promotions offered to the model.** These are the org's promotions that are enabled, run in the next 7 days, and fall within the **Max discount** cap (`eligiblePromotions`). Disabled, expired and over-cap promotions are never shown to the model.
2. **Prompt** (`retail-outreach-backend/src/ai/prompt.ts`, `PROMPT_VERSION`):
   - **System prompt:** store identity, brand voice, the hard compliance rules, the SMS character budget, and one few-shot example per segment (loyal, at-risk, lapsed).
   - **User payload (JSON):** the customer's first name, segment, days since last visit, favorite categories and brands, visit cadence, preferred day/time and recent items; the eligible promotions (id, title, terms, schedule, end date); the engine's suggested pick; the standing offer; and the cap. Last name, phone, email and address are never sent.
3. **Structured output.** A strict JSON schema, validated again with zod:
   `{ promotion_id | null, reason, send_time, sms_text, email_subject, email_body, confidence }`.
4. **Request settings.** Temperature 0.3 (left out for reasoning models), `max_completion_tokens` 500, a 15 s timeout, and 2 SDK retries with exponential backoff on 429, 5xx and connection errors.
5. **Compliance validator** (`src/ai/compliance.ts`). It checks the copy after generation. If the draft is rejected, it is **regenerated once**, with the violations fed back to the model. If the second draft also fails, or the call errors or times out, the suggestion **falls back to the rules engine**.
6. **Cost metrics.** Every call is recorded. A fallback records two rows: the tokens spent on the failed AI attempt (priced), and the rules call (free).

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
OPENAI_API_KEY=sk-... npm run eval -- --live                   # live model; prints tokens + cost
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
