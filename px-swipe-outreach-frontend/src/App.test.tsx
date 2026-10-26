import { render, screen, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import type { OutreachCard } from './types'

const card = (id: string, name: string): OutreachCard => ({
  id, status: 'pending', rationale: 'No purchase in 68 days',
  campaign: { id: 'winback', type: 'win_back', name: 'Win-back' },
  offer: { id: 'WINBACK10', name: 'Win-back 10%', discountPercent: 10, combinable: true },
  customer: {
    id: `c_${id}`, displayName: `${name} M.`, firstName: name, age: 34, gender: 'Female', location: 'Downtown',
    storesShopped: ['Downtown', 'Westside'], lifetimeSpendCents: 86000, daysSinceLastPurchase: 68, itemsPurchased: 3,
    contact: { sms: true, email: true, preferredChannel: 'sms' },
  },
  lastPurchase: { name: 'Leather Tote Bag', category: 'bags', priceCents: 16000, imageUrl: null, daysAgo: 68, alsoPurchased: ['Wallet', 'Scarf'] },
})

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }))
let calls: { url: string; init?: RequestInit }[]

beforeEach(() => {
  calls = []
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (url.includes('/queue')) return json({ items: [card('opp_1', 'Sarah'), card('opp_2', 'Maya')], total: 2 })
    if (url.endsWith('/suggestion')) {
      const { channel } = JSON.parse(String(init?.body))
      return json({ suggestion: { title: 'Welcome them back with 10% off', reasoning: 'Sarah hasn’t shopped in a while.', channel, message: `Hi! (${channel})`, subject: channel === 'email' ? 'We miss you' : null, source: 'rules' } })
    }
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
    expect(await screen.findByText('Welcome them back with 10% off')).toBeInTheDocument()
    expect(screen.getByText('Hi! (sms)')).toBeInTheDocument()
    expect(screen.getByText('SMS · 9 characters')).toBeInTheDocument()
    expect(screen.getByText('Customer has a valid phone number')).toBeInTheDocument()
  })

  it('sends the edited message and advances to the next card', async () => {
    render(<App />)
    await screen.findByText('Hi! (sms)')
    fireEvent.click(screen.getByRole('button', { name: /edit/i }))
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Custom text' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await screen.findByText('Maya M.')
    const send = calls.find(c => c.url.endsWith('/send'))!
    expect(send.url).toBe('/api/outreach/opp_1/send')
    expect(JSON.parse(String(send.init!.body))).toMatchObject({ channel: 'sms', message: 'Custom text' })
    expect(screen.getByText('2 / 2')).toBeInTheDocument()
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
    expect(await screen.findByRole('alert')).toHaveTextContent('Is the backend running?')
  })
})
