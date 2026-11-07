export type Channel = 'sms' | 'email'
export type Segment = 'loyal' | 'at_risk' | 'lapsed'
export type PreferredTime = 'morning' | 'afternoon' | 'evening'

export interface BuyingProfile {
  favoriteCategories: string[]
  favoriteBrands: string[]
  visitsPerMonth: number
  avgBasketCents: number
  /** 0 = Monday … 6 = Sunday */
  preferredDay: number | null
  preferredTime: PreferredTime | null
}

export interface OutreachCard {
  id: string
  status: 'pending' | 'drafted' | 'queued' | 'sent' | 'skipped' | 'failed'
  campaign: { id: string; type: string; name: string }
  rationale: string
  segment: Segment
  offer: { id: string; name: string; discountPercent: number; combinable: boolean } | null
  customer: {
    id: string
    displayName: string
    firstName: string
    age: number | null
    gender: string | null
    location: string | null
    storesShopped: string[]
    lifetimeSpendCents: number
    daysSinceLastPurchase: number | null
    itemsPurchased: number
    ageVerified: boolean
    profile: BuyingProfile
    contact: { sms: boolean; email: boolean; preferredChannel: Channel | null; blockedReason: 'age_unverified' | 'opted_out' | null }
  }
  recentItems: Array<{ name: string; brand: string | null; category: string | null; daysAgo: number | null }>
  lastPurchase: {
    name: string
    category: string | null
    brand: string | null
    priceCents: number
    imageUrl: string | null
    daysAgo: number
    alsoPurchased: string[]
  } | null
}

export interface Suggestion {
  title: string
  reasoning: string
  channel: Channel
  message: string
  subject: string | null
  source: 'openai' | 'rules'
  model?: string
  deal: { id: string; title: string; day: number; discountLabel: string } | null
  reasons: string[]
  segment: Segment
  sendAt: { dayOfWeek: number; time: PreferredTime; label: string } | null
}

export interface SendResult {
  deliveryId: string
  status: string
  duplicate?: boolean
}

export type DiscountType = 'percent' | 'amount' | 'bogo' | 'freebie'
/** weekly = runs on `days`; range = seasonal/ongoing, every day from startsOn to endsOn. */
export type DealSchedule = 'weekly' | 'range'
export interface DealInput {
  schedule: DealSchedule
  days: number[]
  title: string
  description: string
  discountType: DiscountType
  discountValue: number | null
  categories: string[]
  productIds: string[]
  startsOn: string | null
  endsOn: string | null
  active: boolean
}
export interface Deal extends DealInput { id: string; orgId: string; createdAt: string; updatedAt: string }
export interface CatalogProduct { id: string; name: string; brand: string | null; category: string | null; priceCents: number }

export interface OrgSettings {
  storeName: string | null
  emailSignature: string
  smsSignature: string
  defaultChannel: Channel | null
  maxDiscountPercent: number
  /** Suggestion model id; 'rules' = no AI. */
  aiModel: string
  /** How AI suggestions sound. Optional for older servers. */
  brandVoice?: BrandVoice
}

export interface BrandVoice {
  preset: 'friendly' | 'chill' | 'premium'
  emoji: boolean
  /** Email sign-off line, e.g. "See you soon!" */
  signOff: string
  /** A few facts about the shop the AI may use for color. */
  about: string
}

export type OptOutSource = 'sms_stop' | 'email_unsubscribe' | 'manual' | 'provider'
export interface OptOutEntry {
  id: string; channel: Channel; contact: string; customerId: string | null; customerName: string | null
  source: OptOutSource; reason: string; createdAt: string
  reoptIn: { status: 'pending' | 'expired' | 'confirmed'; requestedAt: string; expiresAt: string; nextAllowedAt: string } | null
}
export type ConsentSource = OptOutSource | 'sms_start' | 'email_resubscribe' | 'reoptin_link' | 'store_request'
export interface ConsentEvent {
  id: string; channel: Channel; event: 'opt_out' | 'opt_in' | 'reoptin_requested'; source: ConsentSource
  actorId: string | null; requestId: string | null; createdAt: string
}

export interface ConversationSummary {
  id: string; channel: Channel; customerId: string | null; customerName: string | null; contact: string
  lastMessageAt: string; lastMessagePreview: string; lastDirection: 'inbound' | 'outbound'; unreadCount: number; optedOut: boolean
}
export interface ConversationMessage {
  id: string; conversationId: string; direction: 'inbound' | 'outbound'; kind: 'message' | 'opt_out' | 'opt_in' | 'help' | 'auto'
  status: 'received' | 'queued' | 'sending' | 'sent' | 'failed'; body: string; subject: string | null; sentBy: string | null; createdAt: string
}

export interface AiModelOption {
  id: string; label: string; provider: string; providerLabel: string; inputPerM: number; outputPerM: number
  costHint: string; available: boolean; note: string | null
}

// ── Metrics ──
export interface ModelCost {
  model: string; label: string; aiCalls: number; inputTokens: number; outputTokens: number; costUsd: number
  smsSent: number; emailSent: number; messagesSent: number
}
export interface CostReport {
  year: number; priceTableVersion: string; demo: boolean
  ytd: { costUsd: number; messagesSent: number; aiCalls: number; byModel: ModelCost[] }
  months: Array<{ month: string; models: ModelCost[]; total: Omit<ModelCost, 'model' | 'label'> }>
}
export type Period = 'today' | 'week' | 'month' | 'all'
export interface LeaderRow {
  userKey: string; name: string; isMe: boolean; sends: number; conversions: number; conversionRate: number
  revenueCents: number | null; streakDays: number; onFire: boolean
}
export interface PerformanceReport {
  attributionDays: number; demo: boolean; revenueVisible: boolean
  summary: { thisMonthCents: number; lastMonthCents: number; lastMonthToDateCents: number; monthDay: number; monthGrowthPct: number | null; ytdCents: number
    ytdSends: number; ytdConversions: number; conversionRate: number; avgOrderCents: number }
  trend: Array<{ month: string; revenueCents: number; sends: number; conversions: number }>
  promotions: Array<{ dealId: string | null; title: string; sends: number; usagePct: number; conversions: number; conversionRate: number; revenueCents: number }>
  leaderboard: Record<Period, { rows: LeaderRow[]; totals: { sends: number; conversions: number; conversionRate: number; revenueCents: number | null } }>
}
