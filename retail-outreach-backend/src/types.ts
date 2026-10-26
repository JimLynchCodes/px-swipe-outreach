export type Channel = "sms" | "email";

export type CustomerSummary = {
  id: string;
  firstName: string;
  ageBand: string | null;
  gender: string | null;
  preferredStore: string | null;
  phone: string | null;
  email: string | null;
  smsConsent: boolean;
  emailConsent: boolean;
  optedOut: boolean;
  lifetimeSpendCents: number;
  lastPurchaseAt: string | null;
  daysSinceLastPurchase: number | null;
  recentItems: Array<{ name: string; category: string | null; priceCents: number }>;
};

export type CampaignCandidate = {
  id: string;
  type: string;
  name: string;
  score: number;
  rationale: string;
  offerId: string | null;
};

export type ApprovedOffer = {
  id: string;
  name: string;
  discountPercent: number;
  combinable: boolean;
};

export type ApprovedProduct = {
  id: string;
  name: string;
  category: string | null;
  priceCents: number;
};

export type BrandVoice = {
  tone: string;
  businessName: string;
};
