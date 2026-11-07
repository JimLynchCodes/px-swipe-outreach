import type { Channel } from "../types.js";

export type AiUsageInput = {
  opportunityId: string | null; model: string; provider: string; inputTokens: number; outputTokens: number;
  costUsd: number; priceVersion: string; dealId: string | null; dealTitle: string | null;
};
export type AiUsageRow = AiUsageInput & { id: string; ledToSend: boolean; sentChannel: Channel | null; isDemo: boolean; createdAt: string };

export type SendInput = {
  deliveryId: string | null; userLabel: string; customerId: string; channel: Channel;
  dealId: string | null; dealTitle: string | null; dealCategories: string[]; dealProductIds: string[]; model: string;
};
export type SendRow = SendInput & { id: string; userId: string | null; isDemo: boolean; createdAt: string };

/** A purchase line used for attribution (one row per item). */
export type PurchaseRow = { customerId: string; purchaseId: string; purchasedAt: string; priceCents: number; category: string | null; productId: string | null; isDemo: boolean };
