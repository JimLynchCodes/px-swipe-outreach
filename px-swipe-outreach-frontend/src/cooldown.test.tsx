import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { OUTREACH_SETTINGS_CHANGED } from './settings/events'
import { sinceShort } from './lib/format'
import type { OutreachCard } from './types'

const DAY = 86_400_000
const card = (over: Partial<OutreachCard['customer']['contact']> = {}): OutreachCard => ({
  id: 'opp_1', status: 'pending', rationale: '', campaign: { id: 'w', type: 'win_back', name: 'Win-back' }, offer: null, segment: 'at_risk',
  customer: {
    id: 'c1', displayName: 'Jamal C.', firstName: 'Jamal', age: 41, gender: null, location: null, storesShopped: [], lifetimeSpendCents: 0,
    daysSinceLastPurchase: 9, itemsPurchased: 1, ageVerified: true,
    profile: { favoriteCategories: [], favoriteBrands: [], visitsPerMonth: 1, avgBasketCents: 0, preferredDay: null, preferredTime: null },
    contact: { sms: true, email: true, preferredChannel: 'sms', blockedReason: null,
      lastSent: { sms: new Date(Date.now() - 12 * DAY).toISOString(), email: null }, cooldownUntil: { sms: null, email: null }, ...over },
  },
  recentItems: [], lastPurchase: null,
})
const json = (b: unknown) => Promise.resolve(new Response(JSON.stringify(b), { status: 200 }))
let queueCalls = 0
let current = card()

beforeEach(() => {
  queueCalls = 0
  current = card()
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (url.includes('/queue')) { queueCalls++; return json({ items: [current], total: 1 }) }
    if (url.endsWith('/deck/prepare')) return json({ ok: true, total: 1, generated: 0, cached: 1, failed: 0 })
    if (url.endsWith('/suggestion')) {
      const { channel } = JSON.parse(String(init?.body))
      return json({ suggestion: { title: 'Hi', reasoning: 'r', channel, message: 'Hi', subject: null, source: 'rules', segment: 'at_risk', deal: null, reasons: [], sendAt: null } })
    }
    if (url.endsWith('/api/settings')) return json({ settings: { storeName: null, emailSignature: '', smsSignature: '', defaultChannel: null, maxDiscountPercent: 25, aiModel: 'rules', smsCooldownDays: 0, emailCooldownDays: 0 } })
    if (url.endsWith('/api/deals')) return json({ deals: [] })
    if (url.endsWith('/api/catalog')) return json({ products: [], categories: [] })
    return json({})
  }))
})
afterEach(() => vi.unstubAllGlobals())

describe('contact cooldown on the deck', () => {
  it('formats last-sent compactly', () => {
    expect(sinceShort(null)).toBe('never')
    expect(sinceShort(new Date().toISOString())).toBe('today')
    expect(sinceShort(new Date(Date.now() - 3 * DAY).toISOString())).toBe('3d ago')
  })

  it('shows last text / email subtly on the card', async () => {
    render(<App />)
    expect(await screen.findByLabelText('Last contacted')).toHaveTextContent('Last text 12d ago · Last email never')
  })

  it('disables a channel in cooldown and explains why', async () => {
    current = card({ sms: false, preferredChannel: 'email', cooldownUntil: { sms: new Date(Date.now() + 2 * DAY).toISOString(), email: null } })
    render(<App />)
    const text = await screen.findByRole('radio', { name: /Text/ })
    expect(text).toBeDisabled()
    fireEvent.click(screen.getByRole('radio', { name: /Email/ }))
    expect(screen.getByRole('radio', { name: /Email/ })).toHaveAttribute('aria-checked', 'true')
  })

  it('refetches the deck when settings change', async () => {
    render(<App />)
    await screen.findByText('Jamal C.')
    expect(queueCalls).toBe(1)
    window.dispatchEvent(new Event(OUTREACH_SETTINGS_CHANGED))
    await waitFor(() => expect(queueCalls).toBe(2))
  })
})
