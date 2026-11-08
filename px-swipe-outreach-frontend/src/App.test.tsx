import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import type { OutreachCard } from './types'

const card = (id: string, name: string): OutreachCard => ({
  id, status: 'pending', rationale: 'No purchase in 68 days',
  campaign: { id: 'winback', type: 'win_back', name: 'Win-back' },
  offer: { id: 'WINBACK15', name: 'Win-back 15%', discountPercent: 15, combinable: true }, segment: 'at_risk',
  customer: {
    id: `c_${id}`, displayName: `${name} M.`, firstName: name, age: 34, gender: null, location: 'Downtown',
    storesShopped: ['Downtown', 'Westside'], lifetimeSpendCents: 86000, daysSinceLastPurchase: 58, itemsPurchased: 3, ageVerified: true,
    profile: { favoriteCategories: ['cbd'], favoriteBrands: ['Koi'], visitsPerMonth: 2, avgBasketCents: 4500, preferredDay: 0, preferredTime: 'evening' },
    contact: { sms: true, email: true, preferredChannel: 'sms', blockedReason: null },
  },
  recentItems: [{ name: 'CBD Gummies 25mg', brand: 'Koi', category: 'cbd', daysAgo: 58 }],
  lastPurchase: { name: 'CBD Gummies 25mg', category: 'cbd', brand: 'Koi', priceCents: 3500, imageUrl: null, daysAgo: 58, alsoPurchased: [] },
})

const DEAL = {
  id: 'deal_1', orgId: 'org', schedule: 'weekly', days: [0], title: 'CBD Monday', description: '', discountType: 'percent', discountValue: 15,
  categories: ['cbd'], productIds: [], startsOn: null, endsOn: null, active: true, createdAt: '', updatedAt: '',
}

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }))
let calls: { url: string; init?: RequestInit }[]

beforeEach(() => {
  calls = []
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (url.includes('/queue')) return json({ items: [card('opp_1', 'Sarah'), card('opp_2', 'Maya')], total: 2 })
    if (url.endsWith('/suggestion')) {
      const { channel } = JSON.parse(String(init?.body))
      return json({ suggestion: {
        title: 'Invite them to CBD Monday (15% off)', reasoning: 'Sarah hasn’t shopped in a while.', channel, message: `Hi! (${channel})`,
        subject: channel === 'email' ? 'We miss you' : null, source: 'rules', segment: 'at_risk',
        deal: { id: 'deal_1', title: 'CBD Monday', day: 0, discountLabel: '15% off' }, reasons: ['Buys CBD', 'Usually shops Mondays'],
        sendAt: { dayOfWeek: 6, time: 'evening', label: 'Sunday evening' },
      } })
    }
    if (url.endsWith('/api/settings')) return json({ settings: { storeName: 'Cloud 9', emailSignature: '', smsSignature: '-C9', defaultChannel: null, maxDiscountPercent: 25 } })
    if (url.endsWith('/api/deals')) return json({ deals: [DEAL] })
    if (url.endsWith('/api/catalog')) return json({ products: [], categories: ['cbd'] })
    if (url.endsWith('/send')) return json({ deliveryId: 'd1', status: 'sent' })
    if (url.endsWith('/skip')) return json({ ok: true })
    return json({ error: 'nope' }, 404)
  }))
})
afterEach(() => vi.unstubAllGlobals())

describe('App', () => {
  it('renders the first customer card with stats and AI suggestion', async () => {
    render(<App />)
    expect(await screen.findByText('Sarah M.')).toBeInTheDocument()
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
    expect(screen.getByText('$860')).toBeInTheDocument()
    expect(screen.getByText('Shops at: Downtown, Westside')).toBeInTheDocument()
    expect(screen.getByText('At risk')).toBeInTheDocument()
    expect(screen.getByText('21+ verified')).toBeInTheDocument()
    expect(screen.getByText('Usually shops Mondays, evenings')).toBeInTheDocument()
    expect(await screen.findByText('Invite them to CBD Monday (15% off)')).toBeInTheDocument()
    expect(screen.getByLabelText('Chosen deal')).toHaveTextContent('CBD Monday · 15% off · Monday')
    expect(screen.getByText('Usually shops Mondays')).toBeInTheDocument()
    expect(screen.getByText('Hi! (sms)')).toBeInTheDocument()
    expect(screen.getByText(/SMS · 9\/480 characters/)).toBeInTheDocument()
    expect(screen.getByText('Customer has a valid phone number')).toBeInTheDocument()
    // Deals side panel: Monday slot shows the promotion
    const monday = await screen.findByRole('listitem', { name: 'Monday' })
    expect(monday).toHaveTextContent('CBD Monday')
    expect(screen.getByRole('listitem', { name: 'Tuesday' })).toHaveTextContent('No deals')
  })

  it('blocks sending to a customer whose age is not verified', async () => {
    const base = (globalThis.fetch as unknown as (u: string, i?: RequestInit) => Promise<Response>)
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (url.includes('/queue')) {
        const c = card('opp_1', 'Ryan')
        return json({ items: [{ ...c, customer: { ...c.customer, ageVerified: false, contact: { ...c.customer.contact, blockedReason: 'age_unverified' } } }], total: 1 })
      }
      return base(url, init)
    }))
    render(<App />)
    expect(await screen.findByText(/Age not verified/)).toBeInTheDocument()
    await screen.findByText('Hi! (sms)')
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
  })

  it('uses the store default channel from settings', async () => {
    const base = (globalThis.fetch as unknown as (u: string, i?: RequestInit) => Promise<Response>)
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/api/settings')) return json({ settings: { storeName: null, emailSignature: '', smsSignature: '', defaultChannel: 'email', maxDiscountPercent: 25 } })
      return base(url, init)
    }))
    render(<App />)
    expect(await screen.findByText('Hi! (email)')).toBeInTheDocument()
  })

  it('sends the edited message and advances to the next card', async () => {
    render(<App />)
    await screen.findByText('Hi! (sms)')
    fireEvent.click(screen.getByRole('button', { name: /edit/i }))
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Custom text' } })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await screen.findByText('Maya M.')
    const send = calls.find(c => c.url.endsWith('/send'))!
    expect(send.url).toBe('/api/outreach/opp_1/send')
    expect(JSON.parse(String(send.init!.body))).toMatchObject({ channel: 'sms', message: 'Custom text' })
    expect(screen.getByText('2 / 2')).toBeInTheDocument()
  })

  it('blocks every send path while editing; Done keeps edits, Cancel reverts', async () => {
    render(<App />)
    await screen.findByText('Hi! (sms)')
    fireEvent.click(screen.getByRole('button', { name: /edit/i }))
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Draft A' } })
    const send = screen.getByRole('button', { name: 'Send message' })
    expect(send).toBeDisabled()
    expect(document.querySelector('.edit-hint')).toHaveTextContent('Click Done or Cancel to send')
    expect(screen.getByRole('radio', { name: /email/i })).toBeDisabled()
    // → key (focus outside the textarea) and a swipe right must not send
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    const swipe = document.querySelector('.swipe') as HTMLElement
    fireEvent.pointerDown(swipe, { clientX: 0, pointerId: 1 })
    fireEvent.pointerMove(swipe, { clientX: 300, pointerId: 1 })
    fireEvent.pointerUp(swipe, { clientX: 300, pointerId: 1 })
    await new Promise(r => setTimeout(r, 50))
    expect(calls.some(c => c.url.endsWith('/send'))).toBe(false)
    expect(screen.getByText('Sarah M.')).toBeInTheDocument()

    // Cancel reverts
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('Hi! (sms)')).toBeInTheDocument()
    expect(document.querySelector('.edit-hint')).toBeNull()
    expect(send).not.toBeDisabled()

    // Save keeps the edit, and that's what → sends
    fireEvent.click(screen.getByRole('button', { name: /edit/i }))
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Draft B' } })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.getByText('Draft B')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    await screen.findByText('Maya M.')
    expect(JSON.parse(String(calls.find(c => c.url.endsWith('/send'))!.init!.body)).message).toBe('Draft B')
  })

  it('disables the real Send button the moment editing starts, on both channels', async () => {
    render(<App />)
    await screen.findByText('Hi! (sms)')
    const send = screen.getByRole('button', { name: 'Send message' })
    for (const ch of ['sms', 'email'] as const) {
      if (ch === 'email') { fireEvent.click(screen.getByRole('radio', { name: /email/i })); await screen.findByText('Hi! (email)') }
      expect(send).not.toHaveAttribute('disabled')
      fireEvent.click(screen.getByRole('button', { name: /edit/i }))
      expect(send).toHaveAttribute('disabled')
      expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Done' }))
      expect(send).not.toHaveAttribute('disabled')
    }
  })

  it('re-runs the current suggestion when the AI model changes', async () => {
    render(<App />)
    await screen.findByText('Hi! (sms)')
    const before = calls.filter(c => c.url.endsWith('/suggestion')).length
    // Re-dispatch until the listener (registered in an effect) has picked it up; robust on slow CI runners.
    await waitFor(() => {
      if (calls.filter(c => c.url.endsWith('/suggestion')).length === before) window.dispatchEvent(new Event('ai-model:changed'))
      expect(calls.filter(c => c.url.endsWith('/suggestion')).length).toBeGreaterThan(before)
    })
  })

  it('skips with the arrow key and switches to email', async () => {
    render(<App />)
    await screen.findByText('Hi! (sms)')
    fireEvent.click(screen.getByRole('radio', { name: /email/i }))
    expect(await screen.findByText('Subject: We miss you')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    await screen.findByText('Maya M.')
    expect(calls.some(c => c.url === '/api/outreach/opp_1/skip')).toBe(true)
  })

  it('shows a friendly error when the backend is down', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))))
    render(<App />)
    const alerts = await screen.findAllByRole('alert')
    expect(alerts[0]).toHaveTextContent("Can't reach the server")
    expect(alerts[0]).toHaveClass('error-bubble')
  })
})

describe('opt-out', () => {
  it('posts a per-channel opt-out for the current customer and advances', async () => {
    vi.stubGlobal('confirm', () => true)
    const base = (globalThis.fetch as unknown as (u: string, i?: RequestInit) => Promise<Response>)
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/opt-out')) { calls.push({ url, init }); return json({ ok: true }) }
      return base(url, init)
    }))
    render(<App />)
    expect(await screen.findByText('Sarah M.')).toBeInTheDocument()
    await screen.findByText('Hi! (sms)')
    fireEvent.click(screen.getByText(/Stop texts/))
    expect(await screen.findByText('Maya M.')).toBeInTheDocument()
    const call = calls.find(c => c.url.endsWith('/opt-out'))!
    expect(call.url).toContain('/api/outreach/opp_1/opt-out')
    expect(JSON.parse(String(call.init?.body))).toEqual({ channel: 'sms' })
  })
})

describe('inline action errors', () => {
  it('shows a send failure under the Send button and clears it on retry', async () => {
    let fail = true
    const base = (globalThis.fetch as unknown as (u: string, i?: RequestInit) => Promise<Response>)
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/send') && fail) { fail = false; return json({ error: 'Twilio is not configured' }, 503) }
      return base(url, init)
    }))
    render(<App />)
    await screen.findByText('Hi! (sms)')
    const send = screen.getAllByRole('button', { name: /^Send/ })[0]
    fireEvent.click(send)
    const bubble = await screen.findByRole('alert')
    expect(bubble).toHaveTextContent('Twilio is not configured')
    expect(bubble).toHaveClass('error-bubble')
    expect(send.closest('.action-wrap')).toContainElement(bubble)
    fireEvent.click(send)
    await waitFor(() => expect(screen.queryByText('Twilio is not configured')).toBeNull())
  })
})
