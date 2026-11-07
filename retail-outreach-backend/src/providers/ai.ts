import { z } from "zod";
import { daysSince, discountLabel, withEmailFooter, withSmsOptOut, WEEKDAYS } from "../domain.js";
import { categoryLabel } from "../recommend.js";
import type { Channel, Opportunity, Recommendation, Suggestion } from "../types.js";
import { DEFAULT_AI_MODEL, modelInfo, PROVIDERS, RULES_MODEL } from "../ai/models.js";

export type SuggestionInput = {
  opportunity: Opportunity; channel: Channel; businessName: string; recommendation: Recommendation;
  /** Org signatures appended to the generated message for the matching channel. */
  signatures?: { sms: string; email: string };
  /** Org's chosen model (src/ai/models.ts). Providers that don't serve it ignore it. */
  model?: string;
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

const outputSchema = z.object({
  title: z.string().min(1).max(80),
  reasoning: z.string().min(1).max(400),
  message: z.string().min(1).max(5000),
  subject: z.string().max(200).nullable()
});

/** OpenAI structured-output provider. Writes copy for the deal the engine already chose; minimal customer facts only. */
export class OpenAISuggestionProvider implements SuggestionProvider {
  readonly name = "openai" as const;
  constructor(private apiKey: string, private defaultModel: string = DEFAULT_AI_MODEL) {}

  async suggest(input: SuggestionInput): Promise<Suggestion> {
    const model = input.model && modelInfo(input.model)?.provider === "openai" ? input.model : this.defaultModel;
    const { opportunity, channel, businessName, recommendation: rec } = input;
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: this.apiKey });
    const c = opportunity.customer;
    const response = await client.chat.completions.create({
      model,
      ...(modelInfo(model)?.reasoning ? {} : { temperature: 0.7 }),
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "outreach_suggestion", strict: true,
          schema: {
            type: "object", additionalProperties: false,
            properties: {
              title: { type: "string" }, reasoning: { type: "string" },
              message: { type: "string" }, subject: { type: ["string", "null"] }
            },
            required: ["title", "reasoning", "message", "subject"]
          }
        }
      },
      messages: [
        {
          role: "system",
          content: `You write friendly, never-pushy outreach for ${businessName}, a licensed smoke shop (vape, CBD, glass, papers, cigars, hookah). Customers are verified adults 21+.
Goal: get the customer to visit and grow their basket, using ONLY the supplied deal (or fallback offer).
Rules: only use supplied facts; never invent prices, discounts, stock, or dates. Identify the shop by name. No health or medical claims (especially about CBD), no claims about effects, nothing appealing to minors, no cartoon/youth language. Include "21+" once. Do not mention internal scores, segments, or analytics.
"title" is a short action for staff (e.g. "Invite them to Cigar Friday (20% off)"); "reasoning" is 1-2 sentences for staff explaining why this deal fits this customer.
${channel === "sms" ? 'SMS under 130 characters; do not add a signature or opt-out text (both are appended automatically); "subject" must be null.' : "Short email with a subject; do not sign it (the store signature and unsubscribe footer are appended automatically)."}`
        },
        {
          role: "user",
          content: JSON.stringify({
            channel,
            customer: {
              firstName: c.firstName,
              daysSinceLastVisit: daysSince(c.lastPurchaseAt),
              favoriteCategories: c.profile.favoriteCategories, favoriteBrands: c.profile.favoriteBrands,
              visitsPerMonth: c.profile.visitsPerMonth, preferredDay: c.profile.preferredDay === null ? null : WEEKDAYS[c.profile.preferredDay],
              recentItems: c.purchases.slice(0, 5).map(p => p.name)
            },
            whyChosen: rec.reasons,
            deal: rec.deal ? { title: rec.deal.title, description: rec.deal.description, day: WEEKDAYS[rec.dealDay ?? rec.deal.days[0]], discount: discountLabel(rec.deal) } : null,
            fallbackOffer: rec.deal ? null : opportunity.offer
          })
        }
      ]
    });
    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("AI returned an empty response");
    const usage = response.usage ? { inputTokens: response.usage.prompt_tokens ?? 0, outputTokens: response.usage.completion_tokens ?? 0 } : undefined;
    return finalizeSuggestion(outputSchema.parse(JSON.parse(content)), input, this.name, { model, usage });
  }
}

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
    catch (e) { this.onError(e); return this.rules.suggest(input); }
  }
}

export function createSuggestionProvider(opts: { apiKey?: string; model?: string; onError?: (e: unknown) => void }): SuggestionProvider {
  const providers: Partial<Record<string, SuggestionProvider>> = {};
  if (PROVIDERS.openai.configured({ OPENAI_API_KEY: opts.apiKey })) providers.openai = new OpenAISuggestionProvider(opts.apiKey!, opts.model);
  // e.g. if (opts.anthropicKey) providers.anthropic = new AnthropicSuggestionProvider(opts.anthropicKey);
  return new ModelRouter(providers, new RulesSuggestionProvider(), opts.model ?? DEFAULT_AI_MODEL, opts.onError);
}
