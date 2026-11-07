import { daysSince, discountLabel, withEmailFooter, withSmsOptOut, WEEKDAYS } from "../domain.js";
import { bestDealDay, categoryLabel, dealRunsOn, sendTiming } from "../recommend.js";
import { checkCopy, type Violation } from "../ai/compliance.js";
import { AI_JSON_SCHEMA, aiOutputSchema, systemPrompt, userPayload, type AiOutput, type PromptContext } from "../ai/prompt.js";
import type { BrandVoice, Channel, Deal, Opportunity, Recommendation, Suggestion } from "../types.js";
import { DEFAULT_AI_MODEL, modelInfo, PROVIDERS, RULES_MODEL } from "../ai/models.js";

export type SuggestionInput = {
  opportunity: Opportunity; channel: Channel; businessName: string; recommendation: Recommendation;
  /** Org signatures appended to the generated message for the matching channel. */
  signatures?: { sms: string; email: string };
  /** Org's chosen model (src/ai/models.ts). Providers that don't serve it ignore it. */
  model?: string;
  /** All org promotions; the AI provider filters to enabled, running and within-cap ones. */
  promotions?: Deal[];
  maxDiscountPercent?: number;
  voice?: BrandVoice;
  now?: Date;
};

/** Anything that can turn an opportunity into a suggested outreach message. */
export interface SuggestionProvider {
  readonly name: Suggestion["source"];
  suggest(input: SuggestionInput): Promise<Suggestion>;
}

const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
const list = (xs: string[]) => xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

/** Adds the deal/targeting metadata and the compliance lines every message must carry. */
export function finalizeSuggestion(
  copy: { title: string; reasoning: string; message: string; subject: string | null },
  input: SuggestionInput, source: Suggestion["source"],
  meta: { model?: string; usage?: Suggestion["usage"] } = {}
): Suggestion {
  const { recommendation: rec, channel } = input;
  const sig = (channel === "sms" ? input.signatures?.sms : input.signatures?.email)?.trim();
  const signed = sig && !copy.message.includes(sig) ? `${copy.message.trim()}${channel === "sms" ? " " : "\n\n"}${sig}` : copy.message;
  return {
    ...copy, channel, source, model: meta.model ?? RULES_MODEL, ...(meta.usage ? { usage: meta.usage } : {}),
    message: channel === "sms" ? withSmsOptOut(signed) : withEmailFooter(signed),
    subject: channel === "email" ? copy.subject || `A note from ${input.businessName}` : null,
    deal: rec.deal ? { id: rec.deal.id, title: rec.deal.title, day: rec.dealDay ?? rec.deal.days[0], discountLabel: discountLabel(rec.deal) } : null,
    reasons: rec.reasons, segment: rec.segment, sendAt: rec.sendAt
  };
}

/** Deterministic, offline copy. Used when no OPENAI_API_KEY is set, and as a fallback on AI errors. */
export class RulesSuggestionProvider implements SuggestionProvider {
  readonly name = "rules" as const;

  async suggest(input: SuggestionInput): Promise<Suggestion> {
    const { opportunity, businessName, recommendation: rec } = input;
    const { customer: c, offer } = opportunity;
    const name = c.firstName;
    const pr = c.profile;
    const days = daysSince(c.lastPurchaseAt);
    const favs = list(pr.favoriteCategories.map(categoryLabel));
    const brand = pr.favoriteBrands[0];
    const deal = rec.deal;
    const habit = `${name} buys ${favs || "with us"}${pr.favoriteBrands.length ? ` (${list(pr.favoriteBrands.slice(0, 2))})` : ""} about ${pr.visitsPerMonth}×/month, ~${money(pr.avgBasketCents)} a visit`;

    let title: string, reasoning: string, sms: string, subject: string;
    if (deal) {
      const dealDay = rec.dealDay ?? deal.days[0];
      const day = WEEKDAYS[dealDay];
      const label = discountLabel(deal);
      const dayMatch = pr.preferredDay === dealDay;
      title = rec.segment === "lapsed" ? `Win them back with ${deal.title} (${label})`
        : rec.segment === "at_risk" ? `Bring them in for ${deal.title} (${label})`
        : `Invite them to ${deal.title} (${label})`;
      reasoning = `${habit}. ${deal.title} lines up with that${dayMatch ? ` and runs ${day}, the day they usually shop` : ` and runs ${day}`}${rec.segment === "lapsed" ? `; it's been ${days} days, so a real discount is worth it` : ""}.`;
      const opener = rec.segment === "lapsed" ? `Hi ${name}, it's ${businessName}. We miss you!`
        : rec.segment === "at_risk" ? `Hi ${name}, it's ${businessName}. Haven't seen you in a bit!`
        : `Hi ${name}, it's ${businessName}!`;
      sms = `${opener} ${day} only: ${deal.title}. ${deal.description}${brand && rec.segment === "loyal" ? ` Your ${brand} is in stock.` : ""} 21+ w/ ID.`;
      subject = `${deal.title} this ${day}, ${name}`;
    } else if (offer) {
      // offer percent is already capped by the route to the org's max discount
      title = rec.segment === "lapsed" ? `Win them back with ${offer.discountPercent}% off` : `Thank them with ${offer.discountPercent}% off`;
      reasoning = `${habit}. No weekly deal matches their favorites, so use the standing ${offer.name} offer.`;
      sms = `Hi ${name}, it's ${businessName}! Here's ${offer.discountPercent}% off your next visit${favs ? ` — stock up on ${favs}` : ""}. 21+ w/ ID.`;
      subject = `${offer.discountPercent}% off your next visit, ${name}`;
    } else {
      title = "Share what's new";
      reasoning = `${habit}. A friendly heads-up about new arrivals keeps a regular coming back.`;
      sms = `Hi ${name}, it's ${businessName}! New ${favs || "arrivals"} just landed — come check them out. 21+ w/ ID.`;
      subject = `New ${favs || "arrivals"} at ${businessName}`;
    }
    const body = sms.replace(/^Hi [^,]+, it's [^!.]+[!.] ?/, "");
    const closing = input.signatures?.email.trim() ? "See you soon," : `See you soon,\n${businessName}`;
    const message = input.channel === "sms" ? sms : `Hi ${name},\n\n${body}\n\n${closing}`;
    return finalizeSuggestion({ title, reasoning, message, subject }, input, this.name);
  }
}

/** Minimal slice of the OpenAI SDK used here (injectable for tests and recorded evals). */
export type ChatCompletionClient = {
  create(params: Record<string, unknown>, opts?: { signal?: AbortSignal; timeout?: number; maxRetries?: number }): Promise<{
    choices: Array<{ message?: { content?: string | null } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  }>;
};

/** Thrown when the AI attempt fails (API error, bad JSON, or compliance rejection twice). Carries tokens already spent. */
export class AiAttemptError extends Error {
  constructor(message: string, readonly model: string, readonly usage: { inputTokens: number; outputTokens: number }, readonly violations: Violation[] = [], options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AiAttemptError";
  }
}

export type OpenAIProviderOptions = {
  /** Injected client (tests/evals). Default: the official SDK with SDK-level retries + exponential backoff. */
  client?: ChatCompletionClient;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
  /** SDK retries with exponential backoff on 408/409/429/5xx/connection errors. */
  maxRetries?: number;
  /** Extra generations allowed after a compliance rejection (each gets the violations as feedback). */
  regenerations?: number;
  temperature?: number;
  maxCompletionTokens?: number;
};

/** Promotions the model may choose from: enabled, running within the next 7 days, and within the discount cap. */
export function eligiblePromotions(deals: Deal[], maxDiscountPercent: number, now = Date.now()): Deal[] {
  return deals.filter(d => d.active && [0, 1, 2, 3, 4, 5, 6].some(day => dealRunsOn(d, day, now))
    && !(d.discountType === "percent" && (d.discountValue ?? 0) > maxDiscountPercent));
}

const DEFAULT_VOICE: BrandVoice = { preset: "friendly", emoji: false, signOff: "", about: "" };

/**
 * OpenAI structured-output provider. Chooses one promotion (or none) from the eligible list and writes copy in the
 * org's brand voice; output is zod-validated and checked by the compliance validator (src/ai/compliance.ts).
 * A rejected draft is regenerated once with the violations as feedback; a second failure throws AiAttemptError so the
 * router falls back to rules (and still records the tokens spent).
 */
export class OpenAISuggestionProvider implements SuggestionProvider {
  readonly name = "openai" as const;
  private opts: Required<Omit<OpenAIProviderOptions, "client">> & { client?: ChatCompletionClient };
  constructor(private apiKey: string, private defaultModel: string = DEFAULT_AI_MODEL, opts: OpenAIProviderOptions = {}) {
    this.opts = { timeoutMs: 15_000, maxRetries: 2, regenerations: 1, temperature: 0.3, maxCompletionTokens: 500, ...opts };
  }

  private async client(): Promise<ChatCompletionClient> {
    if (this.opts.client) return this.opts.client;
    const { default: OpenAI } = await import("openai");
    const sdk = new OpenAI({ apiKey: this.apiKey, maxRetries: this.opts.maxRetries, timeout: this.opts.timeoutMs });
    return { create: (params, o) => sdk.chat.completions.create(params as never, o) as never };
  }

  async suggest(input: SuggestionInput): Promise<Suggestion> {
    const model = input.model && modelInfo(input.model)?.provider === "openai" ? input.model : this.defaultModel;
    const now = input.now ?? new Date();
    const cap = input.maxDiscountPercent ?? 100;
    const promotions = eligiblePromotions(input.promotions ?? (input.recommendation.deal ? [input.recommendation.deal] : []), cap, now.getTime());
    const c = input.opportunity.customer;
    const ctx: PromptContext = {
      storeName: input.businessName, voice: input.voice ?? DEFAULT_VOICE, channel: input.channel, smsSignature: input.signatures?.sms ?? "",
      maxDiscountPercent: cap, customer: c, segment: input.recommendation.segment, promotions,
      recommendation: input.recommendation, offer: input.opportunity.offer, now
    };
    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: systemPrompt(ctx) },
      { role: "user", content: JSON.stringify(userPayload(ctx)) }
    ];
    const client = await this.client();
    const usage = { inputTokens: 0, outputTokens: 0 };
    let violations: Violation[] = [];
    for (let attempt = 0; attempt <= this.opts.regenerations; attempt++) {
      let content: string | null | undefined;
      try {
        const res = await client.create({
          model, messages,
          ...(modelInfo(model)?.reasoning ? {} : { temperature: this.opts.temperature }),
          max_completion_tokens: this.opts.maxCompletionTokens,
          response_format: { type: "json_schema", json_schema: AI_JSON_SCHEMA }
        }, { timeout: this.opts.timeoutMs, maxRetries: this.opts.maxRetries });
        usage.inputTokens += res.usage?.prompt_tokens ?? 0;
        usage.outputTokens += res.usage?.completion_tokens ?? 0;
        content = res.choices[0]?.message?.content;
      } catch (e) {
        throw new AiAttemptError(`OpenAI request failed: ${(e as Error).message}`, model, usage, [], { cause: e });
      }
      let out: AiOutput;
      try { out = aiOutputSchema.parse(JSON.parse(content ?? "")); }
      catch { violations = [{ code: "bad_output", message: "Output was not valid JSON for the schema." }]; messages.push({ role: "assistant", content: content ?? "" }, { role: "user", content: feedback(violations) }); continue; }
      const promo = out.promotion_id ? promotions.find(d => d.id === out.promotion_id) ?? null : null;
      violations = out.promotion_id && !promo ? [{ code: "unknown_promotion", message: `promotion_id "${out.promotion_id}" is not in PROMOTIONS.` }] : [];
      const check = checkCopy({ smsText: out.sms_text, emailSubject: out.email_subject, emailBody: out.email_body }, {
        channel: input.channel, firstName: c.firstName, lastName: c.lastName, promotion: promo,
        offerPercent: promo ? null : input.opportunity.offer?.discountPercent ?? null, maxDiscountPercent: cap, smsSignature: ctx.smsSignature, now
      });
      violations.push(...check.violations);
      if (!violations.length) return this.toSuggestion(out, promo, input, model, usage, now);
      messages.push({ role: "assistant", content: content ?? "" }, { role: "user", content: feedback(violations) });
    }
    throw new AiAttemptError(`AI copy rejected: ${violations.map(v => v.code).join(", ")}`, model, usage, violations);
  }

  private toSuggestion(out: AiOutput, promo: Deal | null, input: SuggestionInput, model: string, usage: { inputTokens: number; outputTokens: number }, now: Date): Suggestion {
    const pref = input.opportunity.customer.profile;
    const dealDay = promo ? bestDealDay(promo, pref.preferredDay, now.getTime()) : null;
    const base = input.recommendation;
    const sendAt = dealDay !== null ? { ...sendTiming(dealDay, pref.preferredTime), label: out.send_time } : base.sendAt && { ...base.sendAt, label: out.send_time };
    const rec: Recommendation = { ...base, deal: promo, dealDay, sendAt };
    const verb = base.segment === "lapsed" ? "Win them back with" : base.segment === "at_risk" ? "Bring them in for" : "Invite them to";
    const title = promo ? `${verb} ${promo.title} (${discountLabel(promo)})` : input.opportunity.offer ? `${verb} ${input.opportunity.offer.discountPercent}% off` : "Share what's new";
    const signOff = input.voice?.signOff?.trim();
    const body = signOff && !out.email_body.includes(signOff) ? `${out.email_body.trim()}\n\n${signOff}` : out.email_body;
    const s = finalizeSuggestion({ title: title.slice(0, 80), reasoning: out.reason, message: input.channel === "sms" ? out.sms_text : body, subject: input.channel === "email" ? out.email_subject : null },
      { ...input, recommendation: rec }, this.name, { model, usage });
    return { ...s, confidence: out.confidence };
  }
}

const feedback = (v: Violation[]) => `Your draft was rejected. Fix ALL of these and return the full JSON again:\n${v.map(x => `- ${x.message}`).join("\n")}`;

/** Tries the primary provider and falls back to rules on any error. */
export class FallbackSuggestionProvider implements SuggestionProvider {
  get name() { return this.primary.name; }
  constructor(private primary: SuggestionProvider, private fallback: SuggestionProvider,
    private onError: (e: unknown) => void = () => {}) {}
  async suggest(input: SuggestionInput) {
    try { return await this.primary.suggest(input); }
    catch (e) { this.onError(e); return this.fallback.suggest(input); }
  }
}

/**
 * Routes each suggestion to the provider of the org's chosen model (input.model). "rules", unknown models and models
 * whose provider has no API key use rules; provider errors fall back to rules. Register new providers in `providers`.
 */
export class ModelRouter implements SuggestionProvider {
  readonly name = "rules" as const;
  constructor(private providers: Partial<Record<string, SuggestionProvider>>, private rules: SuggestionProvider = new RulesSuggestionProvider(),
    private defaultModel = DEFAULT_AI_MODEL, private onError: (e: unknown) => void = () => {}) {}
  get primaryName(): Suggestion["source"] { return Object.keys(this.providers).length ? "openai" : "rules"; }
  async suggest(input: SuggestionInput): Promise<Suggestion> {
    const model = input.model ?? this.defaultModel;
    const info = modelInfo(model);
    const provider = info && info.provider !== "rules" ? this.providers[info.provider] : undefined;
    if (!provider) return this.rules.suggest(input);
    try { return await provider.suggest({ ...input, model }); }
    catch (e) {
      this.onError(e);
      const fallback = await this.rules.suggest(input);
      return e instanceof AiAttemptError && (e.usage.inputTokens || e.usage.outputTokens) ? { ...fallback, aiAttempt: { model: e.model, usage: e.usage } } : fallback;
    }
  }
}

export function createSuggestionProvider(opts: { apiKey?: string; model?: string; onError?: (e: unknown) => void; openai?: OpenAIProviderOptions }): SuggestionProvider {
  const providers: Partial<Record<string, SuggestionProvider>> = {};
  if (PROVIDERS.openai.configured({ OPENAI_API_KEY: opts.apiKey })) providers.openai = new OpenAISuggestionProvider(opts.apiKey!, opts.model, opts.openai);
  // e.g. if (opts.anthropicKey) providers.anthropic = new AnthropicSuggestionProvider(opts.anthropicKey);
  return new ModelRouter(providers, new RulesSuggestionProvider(), opts.model ?? DEFAULT_AI_MODEL, opts.onError);
}
