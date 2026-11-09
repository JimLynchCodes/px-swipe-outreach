import { daysSince, discountLabel, withEmailFooter, withSmsOptOut, WEEKDAYS } from "../domain.js";
import { bestDealDay, categoryLabel, dealRunsOn, sendTiming } from "../recommend.js";
import { checkCopy, type Violation } from "../ai/compliance.js";
import { AI_JSON_SCHEMA, aiOutputSchema, smsBudget, systemPrompt, userPayload, type AiOutput, type PromptContext } from "../ai/prompt.js";
import type { BrandVoice, Channel, Deal, Opportunity, Recommendation, Suggestion } from "../types.js";
import { DEFAULT_AI_MODEL, modelInfo, routesFor, RULES_MODEL, type AiKeys } from "../ai/models.js";

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

/** Usable first name for copy, or null when missing/placeholder (never greet as "Hi ," / "Hi ____,"). */
export function greetName(firstName: string | null | undefined): string | null {
  const n = (firstName ?? "").trim();
  if (!n || /^[_\-.…\s]+$/.test(n) || n === "?" || n.toLowerCase() === "customer") return null;
  return n;
}

/** Deterministic, offline copy. Used when no OPENAI_API_KEY is set, and as a fallback on AI errors. */
export class RulesSuggestionProvider implements SuggestionProvider {
  readonly name = "rules" as const;

  async suggest(input: SuggestionInput): Promise<Suggestion> {
    const { opportunity, businessName, recommendation: rec } = input;
    const { customer: c, offer } = opportunity;
    const name = greetName(c.firstName);
    const hi = name ? `Hi ${name}` : "Hi there";
    const pr = c.profile;
    const days = daysSince(c.lastPurchaseAt);
    const favs = list(pr.favoriteCategories.map(categoryLabel));
    const brand = pr.favoriteBrands[0];
    const deal = rec.deal;
    const who = name ?? "This customer";
    const habit = `${who} buys ${favs || "with us"}${pr.favoriteBrands.length ? ` (${list(pr.favoriteBrands.slice(0, 2))})` : ""} about ${pr.visitsPerMonth}×/month, ~${money(pr.avgBasketCents)} a visit`;

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
      const opener = rec.segment === "lapsed" ? `${hi}, it's ${businessName}. We miss you!`
        : rec.segment === "at_risk" ? `${hi}, it's ${businessName}. Haven't seen you in a bit!`
        : `${hi}, it's ${businessName}!`;
      sms = `${opener} ${day} only: ${deal.title}. ${deal.description}${brand && rec.segment === "loyal" ? ` Your ${brand} is in stock.` : ""} 21+ w/ ID.`;
      subject = name ? `${deal.title} this ${day}, ${name}` : `${deal.title} this ${day}`;
    } else if (offer) {
      // offer percent is already capped by the route to the org's max discount
      title = rec.segment === "lapsed" ? `Win them back with ${offer.discountPercent}% off` : `Thank them with ${offer.discountPercent}% off`;
      reasoning = `${habit}. No weekly deal matches their favorites, so use the standing ${offer.name} offer.`;
      sms = `${hi}, it's ${businessName}! Here's ${offer.discountPercent}% off your next visit${favs ? ` — stock up on ${favs}` : ""}. 21+ w/ ID.`;
      subject = name ? `${offer.discountPercent}% off your next visit, ${name}` : `${offer.discountPercent}% off your next visit`;
    } else {
      title = "Share what's new";
      reasoning = `${habit}. A friendly heads-up about new arrivals keeps a regular coming back.`;
      sms = `${hi}, it's ${businessName}! New ${favs || "arrivals"} just landed — come check them out. 21+ w/ ID.`;
      subject = `New ${favs || "arrivals"} at ${businessName}`;
    }
    // Rewards members: quote their real balance when it fits the SMS budget (email always has room).
    if (c.rewards?.member && c.rewards.points !== null && c.rewards.points > 0) {
      const perk = ` You've got ${c.rewards.points.toLocaleString("en-US")} rewards points waiting.`;
      const withPerk = sms.replace(/ 21\+ w\/ ID\.$/, `${perk} 21+ w/ ID.`);
      if (input.channel === "email" || withPerk.length <= smsBudget(input.signatures?.sms ?? "")) sms = withPerk;
    }
    const body = sms.replace(/^Hi [^,]+, it's [^!.]+[!.] ?/, "");
    const closing = input.signatures?.email.trim() ? "See you soon," : `See you soon,\n${businessName}`;
    const message = input.channel === "sms" ? sms : `${hi},\n\n${body}\n\n${closing}`;
    return finalizeSuggestion({ title, reasoning, message, subject }, input, this.name);
  }
}

/** Minimal slice of the OpenAI SDK used here (injectable for tests and recorded evals). */
export type ChatCompletionClient = {
  create(params: Record<string, unknown>, opts?: { signal?: AbortSignal; timeout?: number; maxRetries?: number }): Promise<{
    id?: string;
    choices: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
    /** `cost` (USD) is OpenRouter usage accounting (`usage: { include: true }`). */
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } | null;
  }>;
};

/** Thrown when the AI attempt fails (API error, bad JSON, or compliance rejection twice). Carries tokens already spent. */
export class AiAttemptError extends Error {
  constructor(message: string, readonly model: string, readonly usage: { inputTokens: number; outputTokens: number; costUsd?: number }, readonly violations: Violation[] = [], options?: { cause?: unknown }) {
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
  /** OpenAI-compatible endpoint, e.g. https://openrouter.ai/api/v1 (default: OpenAI). */
  baseURL?: string;
  /** Extra headers (OpenRouter: HTTP-Referer / X-Title for app attribution). */
  headers?: Record<string, string>;
  /** Provider id recorded on suggestions and cost rows. */
  providerId?: "openai" | "openrouter";
  /** Looks up exact cost for a generation id when the response lacks usage.cost (OpenRouter /api/v1/generation). */
  lookupCost?: (generationId: string) => Promise<number | null>;
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
  readonly name: "openai" | "openrouter";
  private opts: Required<Omit<OpenAIProviderOptions, "client" | "baseURL" | "headers" | "lookupCost">> & Pick<OpenAIProviderOptions, "client" | "baseURL" | "headers" | "lookupCost">;
  private defaultModel: string;
  constructor(private apiKey: string, defaultModel?: string, opts: OpenAIProviderOptions = {}) {
    this.opts = { timeoutMs: 15_000, maxRetries: 2, regenerations: 1, temperature: 0.3, maxCompletionTokens: 600, providerId: "openai", ...opts };
    this.name = this.opts.providerId;
    const fallback = this.name === "openrouter" ? DEFAULT_AI_MODEL : "gpt-4o-mini";
    this.defaultModel = defaultModel && modelInfo(defaultModel)?.provider === this.name ? defaultModel : fallback;
  }

  private async client(): Promise<ChatCompletionClient> {
    if (this.opts.client) return this.opts.client;
    const { default: OpenAI } = await import("openai");
    const sdk = new OpenAI({ apiKey: this.apiKey, maxRetries: this.opts.maxRetries, timeout: this.opts.timeoutMs, baseURL: this.opts.baseURL, defaultHeaders: this.opts.headers });
    return { create: (params, o) => sdk.chat.completions.create(params as never, o) as never };
  }

  async suggest(input: SuggestionInput): Promise<Suggestion> {
    const model = input.model && modelInfo(input.model)?.provider === this.name ? input.model : this.defaultModel;
    const now = input.now ?? new Date();
    const cap = input.maxDiscountPercent ?? 100;
    const promotions = eligiblePromotions(input.promotions ?? (input.recommendation.deal ? [input.recommendation.deal] : []), cap, now.getTime());
    const c = input.opportunity.customer;
    const ctx: PromptContext = {
      storeName: input.businessName, voice: input.voice ?? DEFAULT_VOICE, channel: input.channel, smsSignature: input.signatures?.sms ?? "",
      maxDiscountPercent: cap, customer: c, segment: input.recommendation.segment, promotions,
      recommendation: input.recommendation, offer: input.opportunity.offer, now
    };
    const system = systemPrompt(ctx);
    // Prompt caching only for Anthropic on OpenRouter. Other vendors reject that content shape and fail into rules while still billing.
    const anthropicCache = this.name === "openrouter" && model.startsWith("anthropic/");
    const messages: Array<Record<string, unknown>> = [
      anthropicCache
        ? { role: "system", content: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] }
        : { role: "system", content: system },
      { role: "user", content: JSON.stringify(userPayload(ctx)) }
    ];
    const client = await this.client();
    const usage: { inputTokens: number; outputTokens: number; costUsd?: number } = { inputTokens: 0, outputTokens: 0 };
    let exactCost: number | null = this.name === "openrouter" ? 0 : null; // null = unknown, price from the table
    let violations: Violation[] = [];
    for (let attempt = 0; attempt <= this.opts.regenerations; attempt++) {
      let content: string | null | undefined;
      try {
        const res = await client.create({
          model, messages,
          ...(modelInfo(model)?.reasoning ? {} : { temperature: this.opts.temperature }),
          max_completion_tokens: this.opts.maxCompletionTokens,
          response_format: { type: "json_schema", json_schema: AI_JSON_SCHEMA },
          // OpenRouter: only route to endpoints that honor response_format, and return exact cost in `usage`.
          ...(this.name === "openrouter" ? { usage: { include: true }, provider: { require_parameters: true } } : {})
        }, { timeout: this.opts.timeoutMs, maxRetries: this.opts.maxRetries });
        usage.inputTokens += res.usage?.prompt_tokens ?? 0;
        usage.outputTokens += res.usage?.completion_tokens ?? 0;
        if (exactCost !== null) {
          let cost = typeof res.usage?.cost === "number" ? res.usage.cost : null;
          if (cost === null && res.id && this.opts.lookupCost) cost = await this.opts.lookupCost(res.id).catch(() => null);
          exactCost = cost === null ? null : exactCost + cost;
        }
        if (exactCost !== null) usage.costUsd = exactCost; else delete usage.costUsd;
        content = res.choices[0]?.message?.content;
        const finish = res.choices[0]?.finish_reason;
        if (finish === "length") {
          throw new AiAttemptError(`${this.name} output truncated (finish_reason=length); raise max_completion_tokens`, model, usage, [{ code: "truncated", message: "Model output was cut off before valid JSON finished." }]);
        }
      } catch (e) {
        if (e instanceof AiAttemptError) throw e;
        throw new AiAttemptError(`${this.name} request failed: ${(e as Error).message}`, model, usage, [], { cause: e });
      }
      let out: AiOutput;
      try { out = aiOutputSchema.parse(JSON.parse(content ?? "")); }
      catch { violations = [{ code: "bad_output", message: "Output was not valid JSON for the schema." }]; messages.push({ role: "assistant", content: content ?? "" }, { role: "user", content: feedback(violations) }); continue; }
      const promo = out.promotion_id ? promotions.find(d => d.id === out.promotion_id) ?? null : null;
      violations = out.promotion_id && !promo ? [{ code: "unknown_promotion", message: `promotion_id "${out.promotion_id}" is not in PROMOTIONS.` }] : [];
      const check = checkCopy({ smsText: out.sms_text, emailSubject: out.email_subject, emailBody: out.email_body }, {
        channel: input.channel, firstName: c.firstName, lastName: c.lastName, promotion: promo, rewardsPoints: c.rewards?.member ? c.rewards.points : null,
        offerPercent: promo ? null : input.opportunity.offer?.discountPercent ?? null, maxDiscountPercent: cap, smsSignature: ctx.smsSignature, now
      });
      violations.push(...check.violations);
      if (!violations.length) return this.toSuggestion(out, promo, input, model, usage, now);
      messages.push({ role: "assistant", content: content ?? "" }, { role: "user", content: feedback(violations) });
    }
    throw new AiAttemptError(`AI copy rejected: ${violations.map(v => v.code).join(", ")}`, model, usage, violations);
  }

  private toSuggestion(out: AiOutput, promo: Deal | null, input: SuggestionInput, model: string, usage: NonNullable<Suggestion["usage"]>, now: Date): Suggestion {
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
 * Routes each suggestion to a provider for the org's chosen model (input.model) using routesFor(): the primary provider
 * (AI_PROVIDER, default OpenRouter) first, then the same model on the other configured provider, then rules.
 * "rules", unknown models and models with no configured route use rules. Tokens spent on failed attempts are carried
 * on `aiAttempt` so cost metrics still record them.
 */
export class ModelRouter implements SuggestionProvider {
  readonly name = "rules" as const;
  constructor(private providers: Partial<Record<"openai" | "openrouter", SuggestionProvider>>, private rules: SuggestionProvider = new RulesSuggestionProvider(),
    private defaultModel = DEFAULT_AI_MODEL, private onError: (e: unknown) => void = () => {}, private keys?: AiKeys) {}
  get primaryName(): Suggestion["source"] { return this.routeKeys().AI_PROVIDER ?? (this.providers.openrouter ? "openrouter" : this.providers.openai ? "openai" : "rules"); }
  private routeKeys(): AiKeys {
    return this.keys ?? { OPENROUTER_API_KEY: this.providers.openrouter ? "x" : undefined, OPENAI_API_KEY: this.providers.openai ? "x" : undefined };
  }
  async suggest(input: SuggestionInput): Promise<Suggestion> {
    const routes = routesFor(input.model ?? this.defaultModel, this.routeKeys()).filter(r => this.providers[r.provider]);
    let wasted: Suggestion["aiAttempt"] | undefined;
    for (const r of routes) {
      try { return await this.providers[r.provider]!.suggest({ ...input, model: r.model }); }
      catch (e) {
        this.onError(e);
        if (e instanceof AiAttemptError && (e.usage.inputTokens || e.usage.outputTokens)) {
          wasted = { model: e.model, usage: { inputTokens: (wasted?.usage.inputTokens ?? 0) + e.usage.inputTokens, outputTokens: (wasted?.usage.outputTokens ?? 0) + e.usage.outputTokens,
            ...(e.usage.costUsd !== undefined ? { costUsd: (wasted?.usage.costUsd ?? 0) + e.usage.costUsd } : {}) } };
        }
        // A compliance rejection is about the copy, not the provider: don't burn another provider on it.
        if (e instanceof AiAttemptError && e.violations.length) break;
      }
    }
    const fallback = await this.rules.suggest(input);
    return wasted ? { ...fallback, aiAttempt: wasted, template: true } : fallback;
  }
}

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** Exact cost of an OpenRouter generation (GET /api/v1/generation?id=); null if not available yet. */
export function openRouterCostLookup(apiKey: string, fetchImpl: typeof fetch = fetch) {
  return async (id: string): Promise<number | null> => {
    const res = await fetchImpl(`${OPENROUTER_BASE_URL}/generation?id=${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const cost = ((await res.json()) as { data?: { total_cost?: number } }).data?.total_cost;
    return typeof cost === "number" ? cost : null;
  };
}

export function createSuggestionProvider(opts: {
  /** OpenAI (direct) key. */
  apiKey?: string; openrouterKey?: string; aiProvider?: "openrouter" | "openai";
  model?: string; onError?: (e: unknown) => void;
  openai?: OpenAIProviderOptions; openrouter?: OpenAIProviderOptions;
  /** OpenRouter app attribution headers. */
  appUrl?: string; appName?: string;
}): SuggestionProvider {
  const keys: AiKeys = { OPENAI_API_KEY: opts.apiKey, OPENROUTER_API_KEY: opts.openrouterKey, AI_PROVIDER: opts.aiProvider };
  const providers: Partial<Record<"openai" | "openrouter", SuggestionProvider>> = {};
  if (opts.openrouterKey) {
    providers.openrouter = new OpenAISuggestionProvider(opts.openrouterKey, opts.model, {
      providerId: "openrouter", baseURL: OPENROUTER_BASE_URL, lookupCost: openRouterCostLookup(opts.openrouterKey),
      headers: { ...(opts.appUrl ? { "HTTP-Referer": opts.appUrl } : {}), "X-Title": opts.appName ?? "PX Swipe Outreach" }, ...opts.openrouter
    });
  }
  if (opts.apiKey) providers.openai = new OpenAISuggestionProvider(opts.apiKey, opts.model, opts.openai);
  return new ModelRouter(providers, new RulesSuggestionProvider(), opts.model ?? DEFAULT_AI_MODEL, opts.onError, keys);
}
