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
    contact: {
      /** Reachable on this channel right now (consent, contact, not opted out, outside its cooldown). */
      sms: boolean; email: boolean; preferredChannel: Channel | null; blockedReason: 'age_unverified' | 'opted_out' | null
      /** Last outreach send from this app per channel (ISO); null = never. Optional for older servers. */
      lastSent?: { sms: string | null; email: string | null }
      /** When each channel's cooldown ends (ISO); null = not cooling down. */
      cooldownUntil?: { sms: string | null; email: string | null }
    }
  }
  recentItems: Array<{ name: string; brand: string | null; category: string | null; daysAgo: number | null }>
  /** Client-only: opened explicitly from Registered users (bypasses the cooldown filter). */
  picked?: boolean
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
  source: 'openai' | 'openrouter' | 'rules'
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

export interface CustomerSummary {
  id: string; name: string; phone: string | null; email: string | null; location: string | null; source: string | null
  createdAt: string; lastSmsAt: string | null; lastEmailAt: string | null; lifetimeSpendCents: number
}
export interface ImportPreviewRow { row: number; name: string; phone: string | null; email: string | null; location: string | null; lifetimeSpendCents: number; lastPurchaseAt: string | null }
export interface ImportPreview { newCustomers: ImportPreviewRow[]; existing: number; duplicatesInFile: number; invalid: Array<{ row: number; reason: string }>; totalRows: number }
export interface ImportConsent { smsConsent: boolean; emailConsent: boolean; ageVerified: boolean }

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
  /** Minimum days between outreach texts / emails to the same customer (0 = off). Optional for older servers. */
  smsCooldownDays?: number
  emailCooldownDays?: number
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
/** Twilio SMS spend; costUsd includes numberFeesUsd. estimatedTexts are still priced at the configured estimate. */
export interface TwilioCost { costUsd: number; texts: number; segments: number; estimatedTexts: number; numberFeesUsd: number }
export interface CostReport {
  year: number; priceTableVersion: string; demo: boolean; numberMonthlyFeeUsd: number
  ytd: { costUsd: number; messagesSent: number; aiCalls: number; byModel: ModelCost[]; twilio: TwilioCost; combinedUsd: number }
  months: Array<{ month: string; models: ModelCost[]; total: Omit<ModelCost, 'model' | 'label'>; twilio: TwilioCost; combinedUsd: number }>
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

// ── Data sync ──
export type SyncJobId = 'ai-usage' | 'twilio' | 'email' | 'quickvee-rewards' | 'quickvee-orders'
export type SyncFrequency = 'off' | 'daily' | 'weekly' | 'monthly' | 'yearly'
export type SyncLogLine = { at: string; level: 'info' | 'warn' | 'error'; msg: string; data?: Record<string, unknown> }
export type SyncRun = {
  id: string; job: SyncJobId; trigger: 'manual' | 'schedule' | 'backfill' | 'cli'; status: 'running' | 'succeeded' | 'failed'; dryRun: boolean
  params: { from?: string; to?: string }; progress: { phase?: string; done?: number; total?: number }; rowsRead: number; rowsWritten: number
  error: string | null; startedAt: string; finishedAt: string | null; durationMs: number | null; log?: SyncLogLine[]
}
export type SyncSchedule = { job: SyncJobId; frequency: SyncFrequency; startLocal: string; nextRunAt: string | null }
export type SyncSource = {
  id: SyncJobId; label: string; description: string; supportsBackfill: boolean; configured: boolean; missing: string[]
  schedule: SyncSchedule; lastRun: SyncRun | null
}
export type SyncOverview = { timezone: string; schedulerEnabled: boolean; now: string; sources: SyncSource[] }
