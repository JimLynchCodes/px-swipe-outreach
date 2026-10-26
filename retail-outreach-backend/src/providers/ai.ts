import { z } from "zod";
import { daysSince, humanizeDays } from "../domain.js";
import type { Channel, Opportunity, Suggestion } from "../types.js";

export type SuggestionInput = { opportunity: Opportunity; channel: Channel; businessName: string };

/** Anything that can turn an opportunity into a suggested outreach message. */
export interface SuggestionProvider {
  readonly name: Suggestion["source"];
  suggest(input: SuggestionInput): Promise<Suggestion>;
}

const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;

/** Deterministic, offline suggestions. Used when no OPENAI_API_KEY is set, and as a fallback on AI errors. */
export class RulesSuggestionProvider implements SuggestionProvider {
  readonly name = "rules" as const;

  async suggest({ opportunity, channel, businessName }: SuggestionInput): Promise<Suggestion> {
    const { customer: c, offer, campaign } = opportunity;
    const days = daysSince(c.lastPurchaseAt);
    const last = c.purchases[0];
    const name = c.firstName;
    const pronoun = c.gender === "Female" ? "her" : c.gender === "Male" ? "him" : "them";
    const combinable = offer?.combinable ? " — and it can be combined with other discounts" : "";
    const offerText = offer ? `${offer.discountPercent}% off your next purchase with us${combinable}` : "";

    let title: string, reasoning: string, sms: string, subject: string, emailBody: string;
    if (campaign.type === "vip_thanks") {
      title = offer ? `Thank a VIP with ${offer.discountPercent}% off` : "Thank a VIP";
      reasoning = `${name} has spent ${money(c.lifetimeSpendCents)} with us. A personal thank-you${offer ? ` with ${offer.discountPercent}% off` : ""} keeps a top customer feeling valued.`;
      sms = `Hi ${name}! Thank you for being one of our favorite customers.${offer ? ` Here's ${offerText} as a little thank-you.` : ""} We'd love to see you soon!`;
      subject = `A thank-you from ${businessName}`;
    } else if (campaign.type === "win_back") {
      title = offer ? `Welcome them back with ${offer.discountPercent}% off` : "Welcome them back";
      reasoning = `${name} hasn't shopped with us in ${humanizeDays(days)}. A friendly reminder${offer ? ` with ${offer.discountPercent}% off${offer.combinable ? " (combinable with other discounts)" : ""}` : ""} could bring ${pronoun} back.`;
      sms = `Hi ${name}! We miss you!${offer ? ` Enjoy ${offerText}.` : ""} Come find something you'll love!`;
      subject = `We miss you, ${name}`;
    } else {
      title = last ? `Suggest something to pair with the ${last.name}` : "Share what's new";
      reasoning = `${name} shopped ${days ?? "a few"} days ago${last ? ` (${last.name})` : ""}. A personal follow-up while the visit is fresh can lead to a second purchase.`;
      sms = `Hi ${name}! Hope you're loving your ${last?.name ?? "recent pick"}. We just got new arrivals that pair perfectly with it. Stop by and take a look!`;
      subject = `New pieces to go with your ${last?.name ?? "recent purchase"}`;
    }
    emailBody = `Hi ${name},\n\n${sms.replace(/^Hi [^!]+! /, "")}\n\nSee you soon,\n${businessName}`;
    return {
      title, reasoning, channel, source: this.name,
      message: channel === "sms" ? sms : emailBody,
      subject: channel === "email" ? subject : null
    };
  }
}

const outputSchema = z.object({
  title: z.string().min(1).max(80),
  reasoning: z.string().min(1).max(400),
  message: z.string().min(1).max(5000),
  subject: z.string().max(200).nullable()
});

/** OpenAI structured-output provider. Only minimal, non-sensitive customer facts are sent. */
export class OpenAISuggestionProvider implements SuggestionProvider {
  readonly name = "openai" as const;
  constructor(private apiKey: string, private model: string) {}

  async suggest({ opportunity, channel, businessName }: SuggestionInput): Promise<Suggestion> {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: this.apiKey });
    const c = opportunity.customer;
    const response = await client.chat.completions.create({
      model: this.model,
      temperature: 0.7,
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
          content: `You write friendly, warm, never-pushy retail outreach for ${businessName}.
Only use supplied facts. Never invent prices, discount terms, availability, expiration dates, or eligibility.
Do not mention internal scores or analytics. Do not use age or gender to personalize.
"title" is a short action for store staff (e.g. "Welcome them back with 10% off"); "reasoning" is 1-2 sentences for staff.
${channel === "sms" ? 'Write an SMS under 160 characters if possible; "subject" must be null.' : 'Write a short email; include a subject.'}`
        },
        {
          role: "user",
          content: JSON.stringify({
            channel,
            customer: {
              firstName: c.firstName,
              daysSinceLastPurchase: daysSince(c.lastPurchaseAt),
              storesShopped: c.storesShopped,
              recentItems: c.purchases.slice(0, 5).map(p => p.name)
            },
            campaign: { type: opportunity.campaign.type, rationale: opportunity.rationale },
            approvedOffer: opportunity.offer
          })
        }
      ]
    });
    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("AI returned an empty response");
    const out = outputSchema.parse(JSON.parse(content));
    return { ...out, subject: channel === "email" ? out.subject : null, channel, source: this.name };
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

export function createSuggestionProvider(opts: { apiKey?: string; model: string; onError?: (e: unknown) => void }): SuggestionProvider {
  const rules = new RulesSuggestionProvider();
  if (!opts.apiKey) return rules;
  return new FallbackSuggestionProvider(new OpenAISuggestionProvider(opts.apiKey, opts.model), rules, opts.onError);
}
