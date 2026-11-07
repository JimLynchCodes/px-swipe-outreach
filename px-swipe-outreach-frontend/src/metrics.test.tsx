import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Root from './Root'
import { usd } from './lib/format'
import type { CostReport, PerformanceReport } from './types'

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }))
const ORG = { orgId: 'org-1', orgName: 'Cloud 9', businessName: 'Cloud 9' }
function backend(routes: Record<string, () => Promise<Response>>, role: 'owner' | 'staff' = 'owner') {
  const all: Record<string, () => Promise<Response>> = {
    'GET /api/me': () => json({ user: { id: 'u', email: 'me@x.test' }, memberships: [{ ...ORG, role }], authMode: 'demo' }),
    'GET /api/conversations/unread-count': () => json({ count: 0 }),
    ...routes,
  }
  const f = vi.fn((url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url.split('?')[0]}`
    return all[key] ? all[key]() : json({ error: 'not found' }, 404)
  })
  vi.stubGlobal('fetch', f)
  return f
}
const go = (path: string) => { window.history.replaceState(null, '', path); render(<Root config={{ mode: 'demo' }} />) }
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); window.history.replaceState(null, '', '/') })

const SETTINGS = { storeName: 'Cloud 9', emailSignature: '', smsSignature: '-C9', defaultChannel: null, maxDiscountPercent: 25, aiModel: 'gpt-4o-mini' }
const m = (model: string, label: string, o: Partial<CostReport['ytd']['byModel'][number]> = {}) =>
  ({ model, label, aiCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, smsSent: 0, emailSent: 0, messagesSent: 0, ...o })
const TW = (o: object = {}) => ({ costUsd: 0, texts: 0, segments: 0, estimatedTexts: 0, numberFeesUsd: 0, ...o })
const COSTS: CostReport = {
  year: 2026, priceTableVersion: '2026-11-01', demo: true, numberMonthlyFeeUsd: 0,
  ytd: { costUsd: 0.4321, messagesSent: 900, aiCalls: 1100, twilio: TW({ costUsd: 14.11, texts: 1135, segments: 1300, estimatedTexts: 3 }), combinedUsd: 14.5421, byModel: [m('gpt-4o-mini', 'GPT-4o mini', { aiCalls: 800, costUsd: 0.2, messagesSent: 600 }), m('rules', 'None', { aiCalls: 300, messagesSent: 300 })] },
  months: [
    { month: '2026-11', models: [m('gpt-4o-mini', 'GPT-4o mini', { aiCalls: 3, inputTokens: 2100, outputTokens: 450, costUsd: 0.000585, messagesSent: 2 })],
      total: { aiCalls: 3, inputTokens: 2100, outputTokens: 450, costUsd: 0.000585, smsSent: 2, emailSent: 0, messagesSent: 2 },
      twilio: TW({ costUsd: 0.0251, texts: 2, segments: 2, estimatedTexts: 1 }), combinedUsd: 0.025685 },
    { month: '2026-10', models: [], total: { aiCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, smsSent: 0, emailSent: 0, messagesSent: 0 },
      twilio: TW({ costUsd: 13.2, texts: 1000, segments: 1100 }), combinedUsd: 13.2 },
  ],
}
const row = (name: string, o: object) => ({ userKey: name, name, isMe: false, sends: 10, conversions: 2, conversionRate: 0.2, revenueCents: 5000, streakDays: 0, onFire: false, ...o })
const PERF: PerformanceReport = {
  attributionDays: 7, demo: true, revenueVisible: true,
  summary: { thisMonthCents: 120000, lastMonthCents: 300000, lastMonthToDateCents: 100000, monthDay: 7, monthGrowthPct: 20, ytdCents: 900000, ytdSends: 1000, ytdConversions: 250, conversionRate: 0.25, avgOrderCents: 3600 },
  trend: [{ month: '2026-10', revenueCents: 100000, sends: 200, conversions: 50 }, { month: '2026-11', revenueCents: 120000, sends: 210, conversions: 55 }],
  promotions: [{ dealId: 'd1', title: 'Vape Monday', sends: 400, usagePct: 40, conversions: 120, conversionRate: 0.3, revenueCents: 400000 },
    { dealId: null, title: 'No promotion', sends: 600, usagePct: 60, conversions: 130, conversionRate: 0.216, revenueCents: 500000 }],
  leaderboard: {
    today: { rows: [], totals: { sends: 0, conversions: 0, conversionRate: 0, revenueCents: 0 } },
    week: { rows: [row('Maya R. (demo)', { conversions: 9, onFire: true, streakDays: 5 }), row('Leo T. (demo)', { conversions: 5 }), row('Ava K. (demo)', { conversions: 3 }), row('me', { isMe: true, conversions: 1, revenueCents: null })],
      totals: { sends: 40, conversions: 18, conversionRate: 0.45, revenueCents: 20000 } },
    month: { rows: [], totals: { sends: 0, conversions: 0, conversionRate: 0, revenueCents: 0 } },
    all: { rows: [row('Maya R. (demo)', {})], totals: { sends: 10, conversions: 2, conversionRate: 0.2, revenueCents: 5000 } },
  },
}

describe('usd()', () => {
  it('keeps sub-cent precision for tiny costs', () => {
    expect(usd(0)).toBe('$0.00')
    expect(usd(0.000585)).toBe('$0.000585')
    expect(usd(0.4321)).toBe('$0.4321')
    expect(usd(1234.5)).toBe('$1,234.50')
  })
})

describe('Cost metrics', () => {
  it('owners see the YTD summary, per-model rows and months newest first', async () => {
    backend({ 'GET /api/metrics/costs': () => json(COSTS) })
    go('/cost-metrics')
    const ytd = await screen.findByRole('region', { name: 'Year to date' })
    expect(ytd.querySelectorAll(".metric-grid > .metric-card")).toHaveLength(6)
    const twCard = within(ytd).getByText('Total Twilio spend').closest('.metric-card') as HTMLElement
    expect(within(twCard).getByText('$14.11')).toBeInTheDocument()
    expect(twCard).toHaveTextContent('1,135 texts · $0.0124/text')
    expect(within(twCard).getByText('includes estimates')).toBeInTheDocument()
    expect(within(ytd).getByText('Combined spend').closest('.metric-card')).toHaveTextContent('$14.54')
    expect(within(ytd).getByText("Total AI spend")).toHaveClass("metric-label")
    expect(within(ytd).getByText('$0.4321')).toBeInTheDocument()
    expect(within(ytd).getByText('1,100')).toBeInTheDocument()
    expect(within(ytd).getByText('None')).toBeInTheDocument()
    expect(screen.getByText('includes demo data')).toBeInTheDocument()
    const headings = screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)
    expect(headings).toEqual(['Year to date', 'November 2026', 'October 2026'])
    const nov = screen.getByRole('region', { name: 'November 2026' })
    expect(within(nov).getAllByText('$0.000585')).toHaveLength(3) // row + month total + AI spend line
    expect(within(nov).getByText('Month total')).toBeInTheDocument()
    const lines = nov.querySelector('.spend-lines') as HTMLElement
    expect(lines).toHaveTextContent('Twilio$0.0251 2 texts · includes estimates')
    expect(lines).toHaveTextContent('Total$0.0257')
    expect(screen.getByRole('region', { name: 'October 2026' }).querySelector('.spend-lines')).toHaveTextContent('Twilio$13.20 1,000 texts')
  })

  it('is hidden from staff (menu and page)', async () => {
    backend({ 'GET /api/settings': () => json({ settings: SETTINGS }), 'GET /api/deals': () => json({ deals: [] }), 'GET /api/catalog': () => json({ products: [], categories: [] }) }, 'staff')
    go('/settings/costs')
    expect(await screen.findByRole('alert')).toHaveTextContent('Only owners and admins')
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
    expect(within(screen.getByRole('menu')).queryByText('Cost metrics')).toBeNull()
    expect(within(screen.getByRole('menu')).getByText('Performance metrics')).toBeInTheDocument()
  })

  it('is its own menu item right under Performance metrics, not in Settings; the old URL redirects', async () => {
    backend({ 'GET /api/settings': () => json({ settings: SETTINGS }), 'GET /api/deals': () => json({ deals: [] }), 'GET /api/catalog': () => json({ products: [], categories: [] }), 'GET /api/metrics/costs': () => json(COSTS) })
    go('/settings')
    await screen.findByLabelText('Text signature')
    expect(screen.queryByRole('link', { name: 'Cost metrics' })).toBeNull() // no Settings tab
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem').map(x => x.textContent?.trim())
    expect(items[items.indexOf('Performance metrics') + 1]).toBe('Cost metrics')
    fireEvent.click(within(screen.getByRole('menu')).getByText('Cost metrics'))
    expect(window.location.pathname).toBe('/cost-metrics')
    expect(await screen.findByRole('region', { name: 'Year to date' })).toBeInTheDocument()
    go('/settings/costs')
    await waitFor(() => expect(window.location.pathname).toBe('/cost-metrics'))
  })
})

describe('Performance metrics', () => {
  it('shows a red pill when month-to-date is down', async () => {
    backend({ 'GET /api/metrics/performance': () => json({ ...PERF, summary: { ...PERF.summary, monthGrowthPct: -12.5 } }) })
    go('/performance')
    const rev = await screen.findByRole('region', { name: 'Revenue growth' })
    expect(within(rev).getByText(/▼ 12.5%/)).toHaveClass('metric-pill', 'down')
  })

  it('shows growth, promotions and a leaderboard with medals, badges and totals', async () => {
    backend({ 'GET /api/metrics/performance': () => json(PERF) })
    go('/performance')
    const rev = await screen.findByRole('region', { name: 'Revenue growth' })
    expect(within(rev).getByText('$1,200')).toBeInTheDocument()
    expect(within(rev).getByText('Month to date (7 days)')).toBeInTheDocument()
    const pill = within(rev).getByText(/▲ 20.0%/)
    expect(pill).toHaveClass('metric-pill', 'up')
    expect(within(rev).getByText('vs $1,000 same days last month')).toHaveClass('metric-note')
    expect(within(rev).getByText('250 conversions · 1,000 sends')).toBeInTheDocument()
    expect(rev.querySelectorAll('.metric-grid > .metric-card')).toHaveLength(4)
    for (const card of rev.querySelectorAll('.metric-card')) expect(card.firstElementChild).toHaveClass('metric-label')
    expect(within(rev).getByText('25.0%')).toBeInTheDocument()
    expect(within(rev).getByRole('img', { name: /Revenue trend/ })).toBeInTheDocument()
    const promos = screen.getByRole('region', { name: 'Promotions' })
    expect(within(promos).getByText('Vape Monday')).toBeInTheDocument()
    expect(within(promos).getByText('40.0%')).toBeInTheDocument()
    const lb = screen.getByRole('region', { name: 'Staff leaderboard' })
    expect(within(lb).getByLabelText('Rank 1')).toHaveTextContent('🥇')
    expect(within(lb).getByLabelText('Rank 3')).toHaveTextContent('🥉')
    expect(within(lb).getByText('On fire')).toBeInTheDocument()
    expect(within(lb).getByText('5-day streak')).toBeInTheDocument()
    expect(within(lb).getByText('All team members')).toBeInTheDocument()
    expect(within(lb).getByTitle("Only owners and admins see others' revenue")).toBeInTheDocument()
    fireEvent.click(within(lb).getByRole('tab', { name: 'Today' }))
    expect(within(lb).getByText('No sends in this period yet.')).toBeInTheDocument()
    fireEvent.click(within(lb).getByRole('tab', { name: 'All time' }))
    expect(within(lb).getAllByText('Maya R. (demo)')).toHaveLength(1)
  })
})
