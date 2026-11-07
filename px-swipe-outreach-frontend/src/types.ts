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
export interface DealInput {
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
}

export type OptOutSource = 'sms_stop' | 'email_unsubscribe' | 'manual' | 'provider'
export interface OptOutEntry {
  id: string; channel: Channel; contact: string; customerId: string | null; customerName: string | null
  source: OptOutSource; reason: string; createdAt: string
}

export interface ConversationSummary {
  id: string; channel: Channel; customerId: string | null; customerName: string | null; contact: string
  lastMessageAt: string; lastMessagePreview: string; lastDirection: 'inbound' | 'outbound'; unreadCount: number; optedOut: boolean
}
export interface ConversationMessage {
  id: string; conversationId: string; direction: 'inbound' | 'outbound'; kind: 'message' | 'opt_out' | 'opt_in' | 'help' | 'auto'
  status: 'received' | 'queued' | 'sending' | 'sent' | 'failed'; body: string; subject: string | null; sentBy: string | null; createdAt: string
}
