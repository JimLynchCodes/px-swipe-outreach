export type Channel = "sms" | "email";

export type OpportunityStatus =
  "pending" | "drafted" | "skipped" | "queued" | "sent" | "failed" | "suppressed";

export type PurchasedItem = {
  productId: string;
  name: string;
  category: string | null;
  brand: string | null;
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
  /** True once staff checked ID (21+). Age-restricted products are never marketed to unverified customers. */
  ageVerified: boolean;
  profile: BuyingProfile;
};

export type PreferredTime = "morning" | "afternoon" | "evening";
export type Segment = "loyal" | "at_risk" | "lapsed";

/** Buying pattern, typically derived from POS history. */
export type BuyingProfile = {
  favoriteCategories: string[];
  favoriteBrands: string[];
  /** Typical visits per month. */
  visitsPerMonth: number;
  avgBasketCents: number;
  /** 0 = Monday … 6 = Sunday */
  preferredDay: number | null;
  preferredTime: PreferredTime | null;
};

export type DiscountType = "percent" | "amount" | "bogo" | "freebie";

/**
 * A promotion (deal/special). Promotions are reusable entries; `days` places them in the weekly slots
 * and `active` is the on/off switch. Only active promotions running on a given day reach the suggestion engine.
 */
export type DealSchedule = "weekly" | "range";
export type DealInput = {
  /**
   * "weekly": runs on `days` (optionally bounded by startsOn/endsOn).
   * "range": a seasonal/ongoing promotion that runs every day from startsOn to endsOn (both required; days = all 7).
   */
  schedule: DealSchedule;
  /** Weekdays it runs on, 0 = Monday … 6 = Sunday (at least one). */
  days: number[];
  title: string;
  description: string;
  discountType: DiscountType;
  /** Percent (1-100) for "percent", cents for "amount", null otherwise. */
  discountValue: number | null;
  categories: string[];
  productIds: string[];
  /** Inclusive ISO dates (YYYY-MM-DD); null = open-ended. */
  startsOn: string | null;
  endsOn: string | null;
  active: boolean;
};
export type Deal = DealInput & { id: string; orgId: string; createdAt: string; updatedAt: string };

export type CatalogProduct = { id: string; name: string; brand: string | null; category: string | null; priceCents: number };

/** Which deal the engine picked for a customer, and why. */
export type Recommendation = {
  deal: Deal | null;
  /** The weekday the chosen deal will be used (next occurrence). */
  dealDay: number | null;
  score: number;
  reasons: string[];
  segment: Segment;
  /** Suggested send timing, e.g. "Thursday afternoon". */
  sendAt: { dayOfWeek: number; time: PreferredTime; label: string } | null;
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
  /** Deal the message uses (null = fallback offer or no discount). */
  deal: { id: string; title: string; day: number; discountLabel: string } | null;
  /** Why this outreach was chosen (short bullet points for staff). */
  reasons: string[];
  segment: Segment;
  sendAt: Recommendation["sendAt"];
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
  /** Reply-to token of the thread message recorded for this delivery (email only). */
  replyToken?: string | null;
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
/** How an opt-out arrived: STOP reply, email unsubscribe link, staff action, or a provider (bounce/complaint) webhook. */
export type OptOutSource = "sms_stop" | "email_unsubscribe" | "manual" | "provider";

/** How a re-subscribe arrived. */
export type OptInSource = "sms_start" | "email_resubscribe" | "reoptin_link";
export type ConsentEventType = "opt_out" | "opt_in" | "reoptin_requested";
export type ConsentSource = OptOutSource | OptInSource | "store_request";
/** Who/what caused a consent change: a team member (actorId) and/or the HTTP request that carried it. */
export type ConsentMeta = { actorId?: string | null; requestId?: string | null };
export type ConsentEvent = {
  id: string; channel: Channel; event: ConsentEventType; source: ConsentSource;
  actorId: string | null; requestId: string | null; createdAt: string;
};

/** One row of the opt-out list (contact masked; never the raw phone/email). */
export type OptOutEntry = {
  id: string; channel: Channel; contact: string; customerId: string | null; customerName: string | null;
  source: OptOutSource; reason: SuppressionReason; createdAt: string;
  /** Latest re-opt-in request for this contact (pending = sent, not yet confirmed, not expired). */
  reoptIn: { status: "pending" | "expired" | "confirmed"; requestedAt: string; expiresAt: string; nextAllowedAt: string } | null;
};
export const REOPTIN_COOLDOWN_DAYS = 30;
/** A re-opt-in request: one per (org, channel, contact) per 30 days. Carries no message content. */
export type ReoptInRequest = { id: string; orgId: string; channel: Channel; contact: string; status: "pending" | "expired" | "confirmed"; createdAt: string; expiresAt: string };

export type TeamMember = { userId: string; email: string | null; role: MemberRole; joinedAt: string };

export type InvitationStatus = "pending" | "expired" | "accepted" | "revoked";

/** An invitation as shown to owners/admins (never includes the token or its hash). */
export type Invitation = {
  id: string; orgId: string; email: string; role: MemberRole; status: InvitationStatus;
  invitedBy: string | null; createdAt: string; expiresAt: string; lastSentAt: string; sendCount: number;
};

export type InvitationPreview = { orgName: string; email: string; role: MemberRole; status: InvitationStatus; expiresAt: string };

/** Per-organization outreach settings. */
export type OrgSettings = {
  /** Name used in messages; falls back to the organization's business name. */
  storeName: string | null;
  /** Appended to every generated email. */
  emailSignature: string;
  /** Appended to every generated SMS (counts toward SMS length). */
  smsSignature: string;
  /** Preferred first channel when the customer can receive both; null = customer's preference. */
  defaultChannel: Channel | null;
  /** Highest percent discount the engine may offer (deals and fallback offers above it are skipped/capped). */
  maxDiscountPercent: number;
};

export type MessageDirection = "inbound" | "outbound";
/** message = normal text; opt_out/opt_in/help = keyword replies; auto = automatic compliance reply. */
export type MessageKind = "message" | "opt_out" | "opt_in" | "help" | "auto";
export type MessageStatus = "received" | "queued" | "sending" | "sent" | "failed";

export type ConversationMessage = {
  id: string; conversationId: string; direction: MessageDirection; kind: MessageKind; status: MessageStatus;
  body: string; subject: string | null; sentBy: string | null; createdAt: string;
};

export type ConversationSummary = {
  id: string; channel: Channel; customerId: string | null; customerName: string | null;
  /** Masked contact (never the raw phone/email). */
  contact: string;
  lastMessageAt: string; lastMessagePreview: string; lastDirection: MessageDirection;
  unreadCount: number;
  /** The customer opted out of this conversation's channel; replies are blocked. */
  optedOut: boolean;
};

/** Message to append to a thread (system writes: webhooks, deck sends, replies). */
export type NewMessage = {
  direction: MessageDirection; kind: MessageKind; status: MessageStatus; body: string; subject?: string | null;
  sentBy?: string | null; deliveryId?: string | null; providerMessageId?: string | null; createdAt?: Date;
};
