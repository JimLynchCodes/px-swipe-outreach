import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Root from './Root'
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
const DEAL = { id: 'd1', orgId: 'org-1', days: [4], title: 'Cigar Friday', description: '', discountType: 'percent', discountValue: 20,
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
      title: 'CBD Monday', days: [0], discountType: 'percent', discountValue: 15, categories: ['cbd'], active: true }))

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
      customerId: null, customerName: `Cust ${i}`, source: 'sms_stop', reason: '', createdAt: '2026-11-01T00:00:00Z' }))
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
