export type Channel = 'sms' | 'email'

export interface OutreachCard {
  id: string
  status: 'pending' | 'drafted' | 'queued' | 'sent' | 'skipped' | 'failed'
  campaign: { id: string; type: string; name: string }
  rationale: string
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
    contact: { sms: boolean; email: boolean; preferredChannel: Channel | null }
  }
  lastPurchase: {
    name: string
    category: string | null
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
}

export interface SendResult {
  deliveryId: string
  status: string
  duplicate?: boolean
}
