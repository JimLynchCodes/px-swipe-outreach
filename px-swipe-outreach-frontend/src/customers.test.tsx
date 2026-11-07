import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Root from './Root'
import type { OutreachCard } from './types'

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }))
const ORG = { orgId: 'org-1', orgName: 'Cloud 9', businessName: 'Cloud 9', role: 'owner' as const }
type Call = { method: string; url: string; body: { channel?: string } & Record<string, unknown> }
function backend(routes: Record<string, (c: Call) => Promise<Response>>) {
  const calls: Call[] = []
  const all: Record<string, (c: Call) => Promise<Response>> = {
    'GET /api/me': () => json({ user: { id: 'u', email: 'me@x.test' }, memberships: [ORG], authMode: 'demo' }),
    'GET /api/conversations/unread-count': () => json({ count: 0 }),
    'GET /api/sync': () => json({ timezone: 'America/New_York', schedulerEnabled: true, now: '2026-11-07T17:00:00Z', sources: [] }),
    'GET /api/sync/runs': () => json({ runs: [] }),
    ...routes,
  }
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const c = { method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : undefined }
    calls.push(c)
    const h = all[`${c.method} ${url.split('?')[0]}`]
    return h ? h(c) : json({ error: 'not found' }, 404)
  }))
  return calls
}
const go = (path: string) => { window.history.replaceState(null, '', path); render(<Root config={{ mode: 'demo' }} />) }
afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState(null, '', '/') })

const CSV = 'Customer ID,First name,Phone,Email\n1,Avery Test,6095550101,a@example.com\n'
const PREVIEW = {
  newCustomers: [{ row: 1, name: 'Avery Test', phone: '+16***01', email: 'a@***.com', location: 'Burlington', lifetimeSpendCents: 129424, lastPurchaseAt: null }],
  existing: 2, duplicatesInFile: 1, invalid: [{ row: 4, reason: 'No phone or email' }], totalRows: 5,
}
const pickFile = (content: string, name = 'customers.csv', type = 'text/csv') => {
  const file = new File([content], name, { type })
  fireEvent.change(screen.getByLabelText('Customer CSV file'), { target: { files: [file] } })
}

describe('Data sync → Manually add', () => {
  it('previews only new customers, submits with consent, then shows a success modal', async () => {
    const calls = backend({
      'POST /api/customers/import/preview': () => json(PREVIEW),
      'POST /api/customers/import': () => json({ inserted: 1, existing: 2, invalid: 1, duplicatesInFile: 1 }, 201),
    })
    go('/data-sync')
    fireEvent.click(await screen.findByRole('button', { name: 'Manually add' }))
    pickFile(CSV)
    const dialog = await screen.findByRole('dialog', { name: 'Add 1 new customer?' })
    expect(within(dialog).getByText('Avery Test')).toBeInTheDocument()
    expect(within(dialog).getByText(/2 already in your customers · 1 repeated in the file · 1 invalid/)).toBeInTheDocument()
    expect(calls.find(c => c.url.endsWith('/import/preview'))!.body).toEqual({ csv: CSV })
    fireEvent.click(within(dialog).getByLabelText(/marketing texts/))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Submit' }))
    const ok = await screen.findByRole('dialog', { name: 'Customers added' })
    expect(ok).toHaveTextContent('Added 1 new customer. 2 already existed')
    expect(calls.find(c => c.url.endsWith('/api/customers/import'))!.body).toEqual({ csv: CSV, smsConsent: true, emailConsent: false, ageVerified: false })
    fireEvent.click(within(ok).getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('Cancel writes nothing', async () => {
    const calls = backend({ 'POST /api/customers/import/preview': () => json(PREVIEW) })
    go('/data-sync')
    await screen.findByRole('button', { name: 'Manually add' })
    pickFile(CSV)
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(calls.some(c => c.url.endsWith('/api/customers/import'))).toBe(false)
  })

  it('shows server and file errors', async () => {
    backend({ 'POST /api/customers/import/preview': () => json({ error: 'The CSV needs a Phone or Email column.', code: 'invalid_csv' }, 422) })
    go('/data-sync')
    await screen.findByRole('button', { name: 'Manually add' })
    pickFile('a,b\n1,2')
    expect(await screen.findByRole('alert')).toHaveTextContent('Phone or Email column')
    pickFile('x', 'photo.png', 'image/png')
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Please choose a .csv file.'))
  })

  it('keeps the preview open with an error when the save fails', async () => {
    backend({
      'POST /api/customers/import/preview': () => json(PREVIEW),
      'POST /api/customers/import': () => json({ error: 'Database unavailable' }, 503),
    })
    go('/data-sync')
    await screen.findByRole('button', { name: 'Manually add' })
    pickFile(CSV)
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Submit' }))
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent('Database unavailable')
  })
})

const DAY = 86_400_000
const pickedCard = (): OutreachCard => ({
  id: 'opp_9', status: 'pending', rationale: '', campaign: { id: 'manual', type: 'custom', name: 'Manual outreach' }, offer: null, segment: 'loyal',
  customer: {
    id: 'c9', displayName: 'Jamal C.', firstName: 'Jamal', age: 41, gender: null, location: null, storesShopped: [], lifetimeSpendCents: 0,
    daysSinceLastPurchase: 9, itemsPurchased: 1, ageVerified: true,
    profile: { favoriteCategories: [], favoriteBrands: [], visitsPerMonth: 1, avgBasketCents: 0, preferredDay: null, preferredTime: null },
    contact: { sms: true, email: true, preferredChannel: 'sms', blockedReason: null,
      lastSent: { sms: new Date(Date.now() - 3 * DAY).toISOString(), email: new Date(Date.now() - 40 * DAY).toISOString() },
      cooldownUntil: { sms: new Date(Date.now() + 4 * DAY).toISOString(), email: null } },
  },
  recentItems: [], lastPurchase: null,
})

describe('Registered users', () => {
  it('lists customers and opens a fresh card for the clicked one, warning in red inside the cooldown', async () => {
    const calls = backend({
      'GET /api/customers': () => json({ items: [{ id: 'c9', name: 'Jamal Carter', phone: '+15***02', email: 'ja***@example.com', location: null, source: 'csv',
        createdAt: '2026-11-07T00:00:00Z', lastSmsAt: null, lastEmailAt: null, lifetimeSpendCents: 0 }], total: 1, page: 1, pageSize: 50 }),
      'POST /api/customers/c9/open': () => json({ opportunityId: 'opp_9' }),
      'GET /api/outreach/opp_9': () => json(pickedCard()),
      'GET /api/outreach/queue': () => json({ items: [], total: 0 }),
      'POST /api/outreach/opp_9/suggestion': c => json({ suggestion: { title: 'Hi', reasoning: 'r', channel: c.body.channel, message: 'Hi', subject: null, source: 'rules', segment: 'loyal', deal: null, reasons: [], sendAt: null } }),
      'GET /api/settings': () => json({ settings: { storeName: null, emailSignature: '', smsSignature: '', defaultChannel: null, maxDiscountPercent: 25, aiModel: 'rules', smsCooldownDays: 7, emailCooldownDays: 0 } }),
      'GET /api/deals': () => json({ deals: [] }),
      'GET /api/catalog': () => json({ products: [], categories: [] }),
    })
    go('/customers')
    expect(await screen.findByText('Imported')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open Jamal Carter' }))
    expect(await screen.findByText('Jamal C.')).toBeInTheDocument()
    expect(calls.some(c => c.url.endsWith('/api/outreach/opp_9?pick=1'))).toBe(true)
    const line = screen.getByLabelText('Last contacted')
    const recent = line.querySelector('[data-recent]')!
    expect(recent).toHaveClass('recent')
    expect(recent).toHaveTextContent(/Last text 3d ago \(cooldown until/)
    expect(line).toHaveTextContent('Last email 40d ago')
    await waitFor(() => expect(calls.find(c => c.url.endsWith('/opp_9/suggestion'))?.body).toEqual({ channel: 'sms', ignoreCooldown: true }))
    expect(window.location.search).toBe('')
  })
})
