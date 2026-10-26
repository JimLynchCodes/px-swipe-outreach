import OpenAI from "openai";
import { z } from "zod";
import { config } from "../config.js";
import type { ApprovedOffer, ApprovedProduct, BrandVoice, CampaignCandidate, Channel, CustomerSummary } from "../types.js";

const outputSchema = z.object({
  message: z.string().min(1).max(5000),
  subject: z.string().max(200).nullable(),
  rationale: z.string().min(1).max(500),
  recommendedProductIds: z.array(z.string()).max(3)
});

export type DraftOutput = z.infer<typeof outputSchema>;

const client = config.OPENAI_API_KEY ? new OpenAI({ apiKey: config.OPENAI_API_KEY }) : null;

export async function generateDraft(input: {
  customer: CustomerSummary; campaign: CampaignCandidate; channel: Channel;
  products: ApprovedProduct[]; offer: ApprovedOffer | null; brandVoice: BrandVoice;
}): Promise<DraftOutput> {
  const { customer, campaign, channel, products, offer, brandVoice } = input;

  // Offline fallback lets the scaffold run without an API key.
  if (!client) {
    const discount = offer ? ` Enjoy ${offer.discountPercent}% off your next purchase${offer.combinable ? ", combinable with other eligible discounts" : ""}.` : "";
    return {
      message: channel === "sms"
        ? `Hi ${customer.firstName}! We'd love to see you again.${discount} Come find something you'll love!`
        : `Hi ${customer.firstName},\n\nWe'd love to welcome you back.${discount}\n\nVisit us when you're ready to find your next favorite.`,
      subject: channel === "email" ? "A little something for your next visit" : null,
      rationale: campaign.rationale,
      recommendedProductIds: []
    };
  }

  const safeCustomer = {
    firstName: customer.firstName,
    daysSinceLastPurchase: customer.daysSinceLastPurchase,
    preferredStore: customer.preferredStore,
    recentItems: customer.recentItems.map(x => ({ name: x.name, category: x.category }))
  };

  const response = await client.chat.completions.create({
    model: config.OPENAI_MODEL,
    temperature: 0.7,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "retail_outreach_draft",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            message: { type: "string" },
            subject: { type: ["string", "null"] },
            rationale: { type: "string" },
            recommendedProductIds: { type: "array", items: { type: "string" } }
          },
          required: ["message", "subject", "rationale", "recommendedProductIds"]
        }
      }
    },
    messages: [
      {
        role: "system",
        content: `You write helpful retail customer outreach for ${brandVoice.businessName}.
Tone: ${brandVoice.tone}.
Only use supplied facts. Never invent prices, discount terms, availability, expiration dates, or eligibility.
Use only product IDs supplied in APPROVED_PRODUCTS. Do not mention internal scores or private customer analytics.
Do not infer sensitive traits or use age/gender to personalize.
Write a concise ${channel === "sms" ? "SMS, ideally under 300 characters" : "email with a clear subject and readable body"}.
The campaign and offer are backend-approved; do not change them.
Return the requested JSON schema.`
      },
      {
        role: "user",
        content: JSON.stringify({
          customer: safeCustomer,
          campaign: { type: campaign.type, name: campaign.name, rationale: campaign.rationale },
          channel,
          approvedOffer: offer,
          approvedProducts: products.map(p => ({
            id: p.id, name: p.name, category: p.category, priceCents: p.priceCents
          }))
        })
      }
    ]
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("AI returned an empty response");
  return outputSchema.parse(JSON.parse(content));
}
