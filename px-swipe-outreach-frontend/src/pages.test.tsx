import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Root from './Root'
import type { AiModelOption } from './types'
import { relativeTime } from './lib/week'

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }))
type Call = { url: string; method: string; body: unknown }
const ORG = { orgId: 'org-1', orgName: 'Cloud 9', businessName: 'Cloud 9', role: 'owner' as const }

function backend(routes: Record<string, (c: Call) => Promise<Response>>, role: 'owner' | 'staff' = 'owner') {
  const calls: Call[] = []
  const all: Record<string, (c: Call) => Promise<Response>> = {
    'GET /api/me': () => json({ user: { id: 'u', email: 'me@x.test' }, memberships: [{ ...ORG, role }], authMode: 'demo' }),
    'GET /api/conversations/unread-count': () => json({ count: 3 }),
    ...routes,
  }
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const c = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined }
    calls.push(c)
    const key = Object.keys(all).find(k => { const [m, p] = k.split(' '); return m === c.method && url.split('?')[0] === p })
    return key ? all[key](c) : json({ error: 'not found' }, 404)
  }))
  return calls
}
const go = (path: string) => { window.history.replaceState(null, '', path); render(<Root config={{ mode: 'demo' }} />) }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); window.history.replaceState(null, '', '/') })

const SETTINGS = { storeName: 'Cloud 9', emailSignature: 'Cloud 9\n123 Main', smsSignature: '-Cloud 9', defaultChannel: null, maxDiscountPercent: 25 }
const DEAL = { id: 'd1', orgId: 'org-1', schedule: 'weekly', days: [4], title: 'Cigar Friday', description: '', discountType: 'percent', discountValue: 20,
  categories: ['cigars'], productIds: [], startsOn: null, endsOn: null, active: true, createdAt: '', updatedAt: '' }

describe('hamburger menu', () => {
  it('shows the unread badge and links to every page', async () => {
    backend({ 'GET /api/settings': () => json({ settings: SETTINGS }), 'GET /api/deals': () => json({ deals: [] }), 'GET /api/catalog': () => json({ products: [], categories: [] }) })
    go('/settings')
    const btn = await screen.findByRole('button', { name: 'Menu, 3 unread replies' })
    fireEvent.click(btn)
    const menu = screen.getByRole('menu')
    for (const label of ['Outreach deck', 'Replies', 'Opt-out list', 'Team', 'Settings']) expect(within(menu).getByText(label)).toBeInTheDocument()
    expect(within(menu).getByLabelText('3 unread')).toBeInTheDocument()
    fireEvent.click(within(menu).getByText('Opt-out list'))
    expect(window.location.pathname).toBe('/opt-outs')
  })
})

describe('Settings page', () => {
  it('saves signatures, default channel and cap', async () => {
    const calls = backend({
      'GET /api/settings': () => json({ settings: SETTINGS }),
      'PUT /api/settings': c => json({ settings: c.body }),
      'GET /api/deals': () => json({ deals: [DEAL] }),
      'GET /api/catalog': () => json({ products: [], categories: ['cigars'] }),
    })
    go('/settings')
    const sms = await screen.findByLabelText('Text signature')
    expect(screen.getByText(/^8\/60/)).toBeInTheDocument()
    fireEvent.change(sms, { target: { value: '-C9' } })
    fireEvent.change(screen.getByLabelText('Default channel'), { target: { value: 'email' } })
    fireEvent.change(screen.getByLabelText('Max discount (%)'), { target: { value: '20' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))
    expect(await screen.findByText('Settings saved')).toBeInTheDocument()
    expect(calls.find(c => c.method === 'PUT')!.body).toMatchObject({ smsSignature: '-C9', defaultChannel: 'email', maxDiscountPercent: 20 })
  })

  it('toggles, adds and deletes promotions', async () => {
    vi.stubGlobal('confirm', () => true)
    const calls = backend({
      'GET /api/settings': () => json({ settings: SETTINGS }),
      'GET /api/deals': () => json({ deals: [DEAL] }),
      'GET /api/catalog': () => json({ products: [], categories: ['cigars', 'cbd'] }),
      'PUT /api/deals/d1': c => json({ deal: { ...DEAL, ...(c.body as object) } }),
      'POST /api/deals': c => json({ deal: { ...DEAL, id: 'd2', ...(c.body as object) } }, 201),
      'DELETE /api/deals/d1': () => json({ ok: true }),
    })
    go('/settings')
    fireEvent.click(await screen.findByLabelText('Enable Cigar Friday'))
    await waitFor(() => expect(calls.find(c => c.method === 'PUT')?.body).toMatchObject({ active: false, days: [4] }))

    fireEvent.click(screen.getByRole('button', { name: /Add promotion/ }))
    const form = screen.getByRole('form', { name: 'Promotion' })
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'CBD Monday' } })
    fireEvent.change(within(form).getByLabelText('Discount value'), { target: { value: '15' } })
    fireEvent.click(within(form).getByLabelText('Mon'))
    fireEvent.click(within(form).getByLabelText('CBD'))
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls.find(c => c.method === 'POST')?.body).toMatchObject({
      schedule: 'weekly', title: 'CBD Monday', days: [0], discountType: 'percent', discountValue: 15, categories: ['cbd'], active: true }))

    fireEvent.click(screen.getByRole('button', { name: 'Delete Cigar Friday' }))
    await waitFor(() => expect(calls.some(c => c.method === 'DELETE' && c.url.endsWith('/api/deals/d1'))).toBe(true))
  })

  it('is read-only for staff', async () => {
    backend({ 'GET /api/settings': () => json({ settings: SETTINGS }), 'GET /api/deals': () => json({ deals: [DEAL] }),
      'GET /api/catalog': () => json({ products: [], categories: [] }) }, 'staff')
    go('/settings')
    expect(await screen.findByLabelText('Text signature')).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Save settings' })).toBeNull()
    expect(await screen.findByLabelText('Enable Cigar Friday')).toBeDisabled()
    expect(screen.queryByRole('button', { name: /Add promotion/ })).toBeNull()
  })
})

describe('Opt-out list', () => {
  it('lists, filters by channel, searches and paginates', async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ id: `o${i}`, channel: 'sms', contact: '•••-•••-12' + String(i).padStart(2, '0'),
      customerId: null, customerName: `Cust ${i}`, source: 'sms_stop', reason: 'opt_out', createdAt: '2026-11-01T00:00:00Z', reoptIn: null }))
    const calls = backend({ 'GET /api/opt-outs': () => json({ items, total: 45, page: 1, pageSize: 20 }) })
    go('/opt-outs')
    expect(await screen.findByText('Cust 0')).toBeInTheDocument()
    expect(screen.getAllByText('STOP reply')).toHaveLength(20)
    expect(screen.getByText(/Page 1 of 3/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() => expect(calls.some(c => c.url.includes('page=2'))).toBe(true))
    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'email' } })
    await waitFor(() => expect(calls.some(c => c.url.includes('channel=email') && c.url.includes('page=1'))).toBe(true))
    fireEvent.change(screen.getByLabelText('Search opt-outs'), { target: { value: 'chris' } })
    await waitFor(() => expect(calls.some(c => c.url.includes('q=chris'))).toBe(true))
  })
})

const now = Date.now()
const CONVOS = [
  { id: 'cv1', channel: 'sms', customerId: 'c1', customerName: 'Sarah Mitchell', contact: '•••-•••-0101', lastMessageAt: new Date(now - 5 * 60_000).toISOString(),
    lastMessagePreview: 'Is the deal still on?', lastDirection: 'inbound', unreadCount: 1, optedOut: false },
  { id: 'cv2', channel: 'email', customerId: 'c2', customerName: 'Hannah Lee', contact: 'h•••@example.com', lastMessageAt: new Date(now - 3 * 3600_000).toISOString(),
    lastMessagePreview: 'Thanks', lastDirection: 'outbound', unreadCount: 0, optedOut: true },
]
const msgs = (cid: string) => [
  { id: 'm1', conversationId: cid, direction: 'outbound', kind: 'message', status: 'sent', body: 'CBD Monday is 15% off -Cloud 9', subject: null, sentBy: 'u', createdAt: new Date(now - 3600_000).toISOString() },
  { id: 'm2', conversationId: cid, direction: 'inbound', kind: 'message', status: 'received', body: 'Is the deal still on?', subject: null, sentBy: null, createdAt: new Date(now - 300_000).toISOString() },
]

describe('Replies', () => {
  it('lists conversations most recent first with unread state', async () => {
    backend({ 'GET /api/conversations': () => json({ conversations: CONVOS }) })
    go('/replies')
    const list = await screen.findByRole('list', { name: 'Conversations' })
    const rows = within(list).getAllByRole('link')
    expect(rows[0]).toHaveTextContent('Sarah Mitchell')
    expect(rows[0]).toHaveTextContent('5m')
    expect(rows[0]).toHaveClass('unread')
    expect(rows[1]).toHaveTextContent('You: Thanks')
    expect(rows[1]).not.toHaveClass('unread')
    expect(within(rows[0]).getByText('SM')).toBeInTheDocument()
  })

  it('opens a thread, marks it read and replies on the same channel with the signature', async () => {
    const calls = backend({
      'GET /api/conversations/cv1': () => json({ conversation: CONVOS[0], messages: msgs('cv1') }),
      'POST /api/conversations/cv1/read': () => json({ ok: true }),
      'POST /api/conversations/cv1/messages': c => json({ message: { ...msgs('cv1')[0], id: 'm3', body: (c.body as { body: string }).body } }, 201),
      'GET /api/settings': () => json({ settings: SETTINGS }),
    })
    go('/replies/cv1')
    expect(await screen.findByText('Is the deal still on?')).toBeInTheDocument()
    expect(screen.getByText('CBD Monday is 15% off -Cloud 9').closest('.bubble')).toHaveClass('outbound')
    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.url.endsWith('/read'))).toBe(true))
    const box = screen.getByLabelText('Reply message')
    fireEvent.change(box, { target: { value: 'Yes, all day!' } })
    expect(await screen.findByText(/Signature added · 22\/480 characters/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Send/ }))
    await waitFor(() => expect(calls.find(c => c.url.endsWith('/messages'))?.body).toEqual({ body: 'Yes, all day!' }))
  })

  it('blocks replies when the customer opted out of the channel', async () => {
    backend({ 'GET /api/conversations/cv2': () => json({ conversation: { ...CONVOS[1], unreadCount: 0 }, messages: msgs('cv2') }),
      'GET /api/settings': () => json({ settings: SETTINGS }) })
    go('/replies/cv2')
    expect(await screen.findByRole('note')).toHaveTextContent('opted out of email')
    expect(screen.queryByLabelText('Reply message')).toBeNull()
  })

  it('formats relative times like Messages', () => {
    const t = Date.parse('2026-11-07T12:00:00Z')
    expect(relativeTime(new Date(t - 30_000).toISOString(), t)).toBe('now')
    expect(relativeTime(new Date(t - 2 * 3600_000).toISOString(), t)).toBe('2h')
    expect(relativeTime('2026-10-01T12:00:00Z', t)).toMatch(/Oct/)
  })
})

describe('brand', () => {
  it('renders the pineapple logo in the header', async () => {
    const { PineappleLogo } = await import('./components/PineappleLogo')
    const { container } = render(<PineappleLogo title="Pineapple" />)
    expect(screen.getByRole('img', { name: 'Pineapple' })).toBeInTheDocument()
    expect(container.querySelectorAll('path').length).toBeGreaterThanOrEqual(4)
  })
})

const iso = (offset: number) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const SEASONAL = [
  { ...DEAL, id: 's1', schedule: 'range', days: [0, 1, 2, 3, 4, 5, 6], title: 'Holiday Season Glass', categories: ['glass'], startsOn: iso(-2), endsOn: iso(10) },
  { ...DEAL, id: 's2', schedule: 'range', days: [0, 1, 2, 3, 4, 5, 6], title: '4/20 Week', discountType: 'bogo', discountValue: null, startsOn: iso(5), endsOn: iso(11), active: false },
  { ...DEAL, id: 's3', schedule: 'range', days: [0, 1, 2, 3, 4, 5, 6], title: 'Old Summer Sale', startsOn: iso(-60), endsOn: iso(-30) },
]
const deckRoutes = (deals: unknown[]) => ({
  'GET /api/outreach/queue': () => json({ items: [], total: 0 }),
  'GET /api/settings': () => json({ settings: SETTINGS }),
  'GET /api/deals': () => json({ deals }),
  'GET /api/catalog': () => json({ products: [], categories: ['glass', 'papers'] }),
})

describe('Seasonal & ongoing deals', () => {
  it('lists date-range promotions with range, status, discount and enabled state; not in weekly slots', async () => {
    backend(deckRoutes([DEAL, ...SEASONAL]))
    go('/')
    const section = await screen.findByRole('region', { name: /Seasonal & ongoing deals/ })
    const holiday = within(section).getByRole('listitem', { name: 'Holiday Season Glass' })
    expect(holiday).toHaveTextContent('10 days left')
    expect(holiday).toHaveTextContent('20% off')
    expect(holiday).toHaveTextContent('Enabled')
    const w420 = within(section).getByRole('listitem', { name: '4/20 Week' })
    expect(w420).toHaveTextContent('Starts in 5 days')
    expect(w420).toHaveTextContent('Buy one, get one')
    expect(w420).toHaveTextContent('Disabled')
    expect(within(section).queryByText('Old Summer Sale')).toBeNull()
    expect(screen.getByRole('listitem', { name: 'Friday' })).toHaveTextContent('Cigar Friday')
    expect(screen.getByRole('listitem', { name: 'Monday' })).not.toHaveTextContent('Holiday Season Glass')
  })

  it('owners add a seasonal deal with a date range', async () => {
    const calls = backend({ ...deckRoutes([]), 'POST /api/deals': c => json({ deal: { ...DEAL, ...(c.body as object), id: 'n' } }, 201) })
    go('/')
    fireEvent.click(await screen.findByRole('button', { name: 'Add seasonal deal' }))
    const form = screen.getByRole('form', { name: 'Promotion' })
    expect(within(form).getByLabelText('Schedule')).toHaveValue('range')
    expect(within(form).queryByText('Days')).toBeNull()
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'Holiday Season' } })
    fireEvent.change(within(form).getByLabelText('Discount value'), { target: { value: '20' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    await new Promise(r => setTimeout(r, 20))
    expect(calls.some(c => c.method === 'POST')).toBe(false) // dates are required for a date range
    fireEvent.change(within(form).getByLabelText('Starts'), { target: { value: '2026-11-20' } })
    fireEvent.change(within(form).getByLabelText('Ends'), { target: { value: '2026-12-31' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(calls.find(c => c.method === 'POST')?.body).toMatchObject({
      schedule: 'range', days: [0, 1, 2, 3, 4, 5, 6], title: 'Holiday Season', startsOn: '2026-11-20', endsOn: '2026-12-31', discountValue: 20 }))
  })

  it('staff see seasonal deals read-only', async () => {
    backend(deckRoutes(SEASONAL), 'staff')
    go('/')
    await screen.findByText('Holiday Season Glass')
    expect(screen.queryByRole('button', { name: 'Add seasonal deal' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit Holiday Season Glass' })).toBeNull()
  })

  it('"Manage promotions" opens Settings and jumps to the promotions section', async () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    backend(deckRoutes(SEASONAL))
    go('/')
    fireEvent.click(await screen.findByRole('button', { name: /Manage promotions/ }))
    expect(window.location.pathname).toBe('/settings')
    expect(window.location.hash).toBe('#promotions')
    await screen.findByLabelText('Enable Holiday Season Glass')
    await waitFor(() => expect(scroll).toHaveBeenCalled())
    expect(document.activeElement?.id).toBe('promotions')
    expect(screen.getAllByText(/Seasonal · every day/).length).toBe(3)
  })
})

describe('Opt-out list: re-opt-in and consent history', () => {
  const base = { channel: 'email', contact: 'h•••@example.com', customerId: 'c', source: 'email_unsubscribe', reason: 'opt_out', createdAt: '2026-11-01T00:00:00Z' }
  const soon = new Date(Date.now() + 10 * 86_400_000).toISOString()
  const items = [
    { ...base, id: 'o1', customerName: 'Hannah Lee', reoptIn: null },
    { ...base, id: 'o2', customerName: 'Pending Pat', reoptIn: { status: 'pending', requestedAt: '2026-11-02T00:00:00Z', expiresAt: soon, nextAllowedAt: soon } },
    { ...base, id: 'o3', customerName: 'Cooling Cal', reoptIn: { status: 'expired', requestedAt: '2026-10-20T00:00:00Z', expiresAt: '2026-11-01T00:00:00Z', nextAllowedAt: soon } },
  ]
  const EVENTS = [
    { id: 'e2', channel: 'email', event: 'reoptin_requested', source: 'store_request', actorId: 'u', requestId: 'r2', createdAt: '2026-11-03T00:00:00Z' },
    { id: 'e1', channel: 'email', event: 'opt_out', source: 'email_unsubscribe', actorId: null, requestId: 'req-1', createdAt: '2026-11-01T00:00:00Z' },
  ]

  it('owners send a re-opt-in request; pending and cooldown rows show status instead', async () => {
    vi.stubGlobal('confirm', () => true)
    const calls = backend({
      'GET /api/opt-outs': () => json({ items, total: 3, page: 1, pageSize: 20 }),
      'POST /api/opt-outs/o1/reopt-in': () => json({ ok: true, channel: 'email', status: 'pending' }, 201),
    })
    go('/opt-outs')
    await screen.findByText('Hannah Lee')
    expect(screen.getAllByRole('button', { name: /Send re-opt-in request/ })).toHaveLength(1)
    expect(screen.getByText(/Pending since/)).toBeInTheDocument()
    expect(screen.getByText(/Next request after/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Send re-opt-in request/ }))
    expect(await screen.findByText('Re-opt-in request sent to Hannah Lee')).toBeInTheDocument()
    expect(calls.some(c => c.method === 'POST' && c.url.endsWith('/api/opt-outs/o1/reopt-in'))).toBe(true)
    expect(calls.filter(c => c.url.startsWith('/api/opt-outs?')).length).toBeGreaterThanOrEqual(2) // list refreshed
  })

  it('shows the server reason when a request is refused', async () => {
    vi.stubGlobal('confirm', () => true)
    backend({
      'GET /api/opt-outs': () => json({ items: [items[0]], total: 1, page: 1, pageSize: 20 }),
      'POST /api/opt-outs/o1/reopt-in': () => json({ error: 'Texting a number that replied STOP is restricted.', code: 'sms_reoptin_disabled' }, 403),
    })
    go('/opt-outs')
    fireEvent.click(await screen.findByRole('button', { name: /Send re-opt-in request/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Texting a number that replied STOP is restricted.')
  })

  it('staff see no request button', async () => {
    backend({ 'GET /api/opt-outs': () => json({ items: [items[0]], total: 1, page: 1, pageSize: 20 }) }, 'staff')
    go('/opt-outs')
    await screen.findByText('Hannah Lee')
    expect(screen.queryByRole('button', { name: /Send re-opt-in request/ })).toBeNull()
  })

  it('expands a row to show consent history', async () => {
    backend({
      'GET /api/opt-outs': () => json({ items: [items[0]], total: 1, page: 1, pageSize: 20 }),
      'GET /api/opt-outs/o1/history': () => json({ events: EVENTS }),
    })
    go('/opt-outs')
    const toggle = await screen.findByRole('button', { name: 'History for Hannah Lee' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    const list = await screen.findByRole('list', { name: 'Consent history' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('Re-opt-in requested · Email · Store request')
    expect(rows[0]).toHaveTextContent('by a team member')
    expect(rows[1]).toHaveTextContent('Opted out · Email · Unsubscribe link')
    expect(rows[1]).toHaveTextContent('ref req-1')
  })
})

describe('AI model picker', () => {
  const MODELS: AiModelOption[] = [
    { id: 'gpt-4o-mini', label: 'GPT-4o mini', provider: 'openai', providerLabel: 'OpenAI', inputPerM: 0.15, outputPerM: 0.6, costHint: '~$0.020 per 100 suggestions', available: true, note: null },
    { id: 'gpt-5-mini', label: 'GPT-5 mini', provider: 'openai', providerLabel: 'OpenAI', inputPerM: 0.25, outputPerM: 2, costHint: '~$0.05 per 100 suggestions', available: true, note: null },
    { id: 'rules', label: 'None', provider: 'rules', providerLabel: 'Built-in rules', inputPerM: 0, outputPerM: 0, costHint: 'Heuristic-based canned suggestions, free', available: true, note: null },
  ]
  const routes = (selected: { v: string }, models = MODELS) => ({
    'GET /api/ai/models': () => json({ models, selected: selected.v, effective: models.find(m => m.id === selected.v)?.available ? selected.v : 'rules', priceTableVersion: '2026-11-07' }),
    'GET /api/settings': () => json({ settings: { ...SETTINGS, aiModel: selected.v } }),
    'PUT /api/settings': (c: Call) => { selected.v = (c.body as { aiModel: string }).aiModel; return json({ settings: c.body }) },
    'GET /api/deals': () => json({ deals: [] }), 'GET /api/catalog': () => json({ products: [], categories: [] }),
    'GET /api/outreach/queue': () => json({ items: [], total: 0 }),
  })

  it('shows the current model, and owners switch it (saved to settings, event fired)', async () => {
    const sel = { v: 'gpt-4o-mini' }
    const calls = backend(routes(sel))
    const changed = vi.fn()
    window.addEventListener('ai-model:changed', changed)
    go('/')
    const pill = await screen.findByRole('button', { name: /Using model GPT-4o mini/ })
    fireEvent.click(pill)
    const menu = screen.getByRole('menu', { name: 'AI model' })
    expect(within(menu).getByRole('menuitemradio', { name: /GPT-4o mini/ })).toHaveAttribute('aria-checked', 'true')
    expect(within(menu).getByText('Heuristic-based canned suggestions, free')).toBeInTheDocument()
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /GPT-5 mini/ }))
    await screen.findByRole('button', { name: /Using model GPT-5 mini/ })
    expect(calls.find(c => c.method === 'PUT')?.body).toMatchObject({ aiModel: 'gpt-5-mini', storeName: 'Cloud 9' })
    expect(changed).toHaveBeenCalled()
    window.removeEventListener('ai-model:changed', changed)
  })

  it('without an API key, OpenAI models are unavailable and rules are used', async () => {
    const sel = { v: 'gpt-4o-mini' }
    const models = MODELS.map(m => m.provider === 'openai' ? { ...m, available: false, note: 'Set OPENAI_API_KEY on the server to enable OpenAI models.' } : m)
    backend(routes(sel, models))
    go('/')
    fireEvent.click(await screen.findByRole('button', { name: /fallback: None/ }))
    expect(screen.getByRole('menuitemradio', { name: /GPT-5 mini/ })).toBeDisabled()
    expect(screen.getAllByText('Unavailable').length).toBe(2)
    expect(screen.getByText(/Set OPENAI_API_KEY/)).toBeInTheDocument()
  })

  it("choosing 'None' shows 'Using model None'", async () => {
    const sel = { v: 'gpt-4o-mini' }
    backend(routes(sel))
    go('/')
    fireEvent.click(await screen.findByRole('button', { name: /Using model GPT-4o mini/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^None/ }))
    expect(await screen.findByRole('button', { name: /^Using model None$/ })).toBeInTheDocument()
    expect(sel.v).toBe('rules')
  })

  it('staff see the list read-only', async () => {
    backend(routes({ v: 'gpt-4o-mini' }), 'staff')
    go('/')
    fireEvent.click(await screen.findByRole('button', { name: /Using model/ }))
    expect(screen.getByText('Only owners and admins can change the model.')).toBeInTheDocument()
    expect(screen.getByRole('menuitemradio', { name: /GPT-5 mini/ })).toBeDisabled()
  })
})
