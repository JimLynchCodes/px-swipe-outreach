import { render, screen, fireEvent, within } from '@testing-library/react'
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
const COSTS: CostReport = {
  year: 2026, priceTableVersion: '2026-11-01', demo: true,
  ytd: { costUsd: 0.4321, messagesSent: 900, aiCalls: 1100, byModel: [m('gpt-4o-mini', 'GPT-4o mini', { aiCalls: 800, costUsd: 0.2, messagesSent: 600 }), m('rules', 'Rules only', { aiCalls: 300, messagesSent: 300 })] },
  months: [
    { month: '2026-11', models: [m('gpt-4o-mini', 'GPT-4o mini', { aiCalls: 3, inputTokens: 2100, outputTokens: 450, costUsd: 0.000585, messagesSent: 2 })],
      total: { aiCalls: 3, inputTokens: 2100, outputTokens: 450, costUsd: 0.000585, smsSent: 2, emailSent: 0, messagesSent: 2 } },
    { month: '2026-10', models: [], total: { aiCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, smsSent: 0, emailSent: 0, messagesSent: 0 } },
  ],
}
const row = (name: string, o: object) => ({ userKey: name, name, isMe: false, sends: 10, conversions: 2, conversionRate: 0.2, revenueCents: 5000, streakDays: 0, onFire: false, ...o })
const PERF: PerformanceReport = {
  attributionDays: 7, demo: true, revenueVisible: true,
  summary: { thisMonthCents: 120000, lastMonthCents: 100000, monthGrowthPct: 20, ytdCents: 900000, ytdSends: 1000, ytdConversions: 250, conversionRate: 0.25, avgOrderCents: 3600 },
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
    go('/settings/costs')
    const ytd = await screen.findByRole('region', { name: 'Year to date' })
    expect(within(ytd).getByText('$0.4321')).toBeInTheDocument()
    expect(within(ytd).getByText('1,100')).toBeInTheDocument()
    expect(within(ytd).getByText('Rules only')).toBeInTheDocument()
    expect(screen.getByText('includes demo data')).toBeInTheDocument()
    const headings = screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)
    expect(headings).toEqual(['Year to date', 'November 2026', 'October 2026'])
    const nov = screen.getByRole('region', { name: 'November 2026' })
    expect(within(nov).getAllByText('$0.000585')).toHaveLength(2) // row + month total
    expect(within(nov).getByText('Month total')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Cost metrics' })).toHaveAttribute('aria-current', 'page')
  })

  it('is linked from the menu and settings tabs for owners, hidden from staff', async () => {
    backend({ 'GET /api/settings': () => json({ settings: SETTINGS }), 'GET /api/deals': () => json({ deals: [] }), 'GET /api/catalog': () => json({ products: [], categories: [] }) }, 'staff')
    go('/settings/costs')
    expect(await screen.findByRole('alert')).toHaveTextContent('Only owners and admins')
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
    expect(within(screen.getByRole('menu')).queryByText('Cost metrics')).toBeNull()
    expect(within(screen.getByRole('menu')).getByText('Performance metrics')).toBeInTheDocument()
  })

  it('owners reach it from the Settings tab', async () => {
    backend({ 'GET /api/settings': () => json({ settings: SETTINGS }), 'GET /api/deals': () => json({ deals: [] }), 'GET /api/catalog': () => json({ products: [], categories: [] }), 'GET /api/metrics/costs': () => json(COSTS) })
    go('/settings')
    fireEvent.click(await screen.findByRole('link', { name: 'Cost metrics' }))
    expect(window.location.pathname).toBe('/settings/costs')
    expect(await screen.findByRole('region', { name: 'Year to date' })).toBeInTheDocument()
  })
})

describe('Performance metrics', () => {
  it('shows growth, promotions and a leaderboard with medals, badges and totals', async () => {
    backend({ 'GET /api/metrics/performance': () => json(PERF) })
    go('/performance')
    const rev = await screen.findByRole('region', { name: 'Revenue growth' })
    expect(within(rev).getByText('$1,200')).toBeInTheDocument()
    expect(within(rev).getByText(/20.0% vs last month/)).toBeInTheDocument()
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
