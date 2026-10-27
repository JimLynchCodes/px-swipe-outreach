export type Channel = "sms" | "email";

export type OpportunityStatus =
  "pending" | "drafted" | "skipped" | "queued" | "sent" | "failed" | "suppressed";

export type PurchasedItem = {
  productId: string;
  name: string;
  category: string | null;
  priceCents: number;
  imageUrl: string | null;
  purchasedAt: string;
};

/** Internal customer view. Contains contact details: never send raw to the browser. */
export type Customer = {
  id: string;
  firstName: string;
  lastName: string;
  age: number | null;
  gender: string | null;
  location: string | null;
  storesShopped: string[];
  phone: string | null;
  email: string | null;
  smsConsent: boolean;
  emailConsent: boolean;
  /** Channels on which this customer's contact value is on the org's suppression (do-not-contact) list. */
  suppressed: Channel[];
  lifetimeSpendCents: number;
  lastPurchaseAt: string | null;
  itemsPurchased: number;
  /** Most recent first. */
  purchases: PurchasedItem[];
};

export type Offer = { id: string; name: string; discountPercent: number; combinable: boolean };

export type Opportunity = {
  id: string;
  orgId: string;
  status: OpportunityStatus;
  campaign: { id: string; type: string; name: string };
  score: number;
  rationale: string;
  offer: Offer | null;
  customer: Customer;
};

export type Suggestion = {
  title: string;
  reasoning: string;
  channel: Channel;
  message: string;
  subject: string | null;
  source: "openai" | "rules";
};

export type DeliveryStatus = "queued" | "sending" | "sent" | "delivered" | "failed";

export type Delivery = {
  id: string;
  orgId: string;
  opportunityId: string;
  channel: Channel;
  recipient: string;
  message: string;
  subject: string | null;
  status: DeliveryStatus;
  providerMessageId: string | null;
  error: string | null;
  idempotencyKey: string;
  createdAt: string;
};

export type Metrics = {
  opportunities: Array<{ status: string; count: number }>;
  deliveries: Array<{ status: string; channel: string; count: number }>;
};

export type MemberRole = "owner" | "admin" | "staff";

export type Membership = { orgId: string; orgName: string; businessName: string | null; role: MemberRole };

/** Who is acting, and in which organization. Every user-facing store call is scoped by this. */
export type Actor = { userId: string; orgId: string };

export type SuppressionReason = "opt_out" | "bounce" | "complaint" | "manual";
