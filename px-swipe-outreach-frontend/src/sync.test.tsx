import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Root from './Root'
import { fmtDuration, fmtTime } from './sync/DataSyncPage'
import type { SyncOverview, SyncRun, SyncSource } from './types'

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }))
const ORG = { orgId: 'org-1', orgName: 'Cloud 9', businessName: 'Cloud 9' }
type Handler = (init?: RequestInit, url?: string) => Promise<Response>
function backend(routes: Record<string, Handler>, role: 'owner' | 'staff' = 'owner') {
  const all: Record<string, Handler> = {
    'GET /api/me': () => json({ user: { id: 'u', email: 'me@x.test' }, memberships: [{ ...ORG, role }], authMode: 'demo' }),
    'GET /api/conversations/unread-count': () => json({ count: 0 }),
    ...routes,
  }
  const calls: Array<{ method: string; url: string; body: unknown }> = []
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const key = `${method} ${url.split('?')[0]}`
    return all[key] ? all[key](init, url) : json({ error: 'not found' }, 404)
  }))
  return calls
}
const go = (path: string) => { window.history.replaceState(null, '', path); render(<Root config={{ mode: 'demo' }} />) }
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); window.history.replaceState(null, '', '/') })

const run = (o: Partial<SyncRun> = {}): SyncRun => ({ id: 'r1', job: 'twilio', trigger: 'manual', status: 'succeeded', dryRun: false, params: {}, progress: {}, rowsRead: 120, rowsWritten: 118,
  error: null, startedAt: '2026-11-07T15:00:00.000Z', finishedAt: '2026-11-07T15:00:42.000Z', durationMs: 42_000, ...o })
const src = (id: SyncSource['id'], label: string, o: Partial<SyncSource> = {}): SyncSource => ({ id, label, description: `${label} description`, supportsBackfill: id === 'quickvee-orders',
  configured: true, missing: [], schedule: { job: id, frequency: 'off', startLocal: '2026-11-08T03:00:00', nextRunAt: null }, lastRun: null, ...o })
const overview = (sources: SyncSource[]): SyncOverview => ({ timezone: 'America/New_York', schedulerEnabled: true, now: '2026-11-07T17:00:00Z', sources })

describe('formatting', () => {
  it('shows times in the store timezone and compact durations', () => {
    expect(fmtTime('2026-11-15T15:00:00.000Z', 'America/New_York')).toBe('Nov 15, 2026, 10:00:00 AM')
    expect(fmtTime(null, 'UTC')).toBe('–')
    expect(fmtDuration(420)).toBe('420 ms')
    expect(fmtDuration(42_000)).toBe('42s')
    expect(fmtDuration(125_000)).toBe('2m 5s')
  })
})

describe('Data sync page', () => {
  it('is in the menu for owners/admins only and blocks staff', async () => {
    backend({ 'GET /api/outreach/queue': () => json({ items: [], total: 0 }), 'GET /api/ai/models': () => json({ models: [], selected: 'rules', effective: 'rules', priceTableVersion: 'x' }) }, 'staff')
    go('/data-sync')
    expect(await screen.findByText('Only owners and admins can manage data sync.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
    expect(screen.queryByRole('menuitem', { name: /Data sync/ })).not.toBeInTheDocument()
  })

  it('shows one card per source: status, last run, rows, error, next run, and not-configured env names', async () => {
    backend({
      'GET /api/sync': () => json(overview([
        src('ai-usage', 'AI usage', { lastRun: run({ job: 'ai-usage', status: 'failed', error: 'GET /api/v1/activity failed: HTTP 401' }) }),
        src('twilio', 'Twilio', { lastRun: run(), schedule: { job: 'twilio', frequency: 'daily', startLocal: '2026-11-15T10:00:00', nextRunAt: '2026-11-15T15:00:00.000Z' } }),
        src('quickvee-rewards', 'Quickvee rewards', { configured: false, missing: ['QUICKVEE_EMAIL', 'QUICKVEE_PASSWORD'] }),
      ])),
      'GET /api/sync/runs': () => json({ runs: [run()] }),
    })
    go('/data-sync')
    const tw = await screen.findByRole('region', { name: 'Twilio' })
    expect(within(tw).getByText('Up to date')).toBeInTheDocument()
    expect(within(tw).getByText('Nov 7, 2026, 10:00:00 AM')).toBeInTheDocument()
    expect(within(tw).getByText('42s')).toBeInTheDocument()
    expect(within(tw).getByText('120 read · 118 written')).toBeInTheDocument()
    expect(within(tw).getByText('Nov 15, 2026, 10:00:00 AM')).toBeInTheDocument()
    const ai = screen.getByRole('region', { name: 'AI usage' })
    expect(within(ai).getByText('Failed')).toBeInTheDocument()
    expect(within(ai).getByRole('alert')).toHaveTextContent('Last error: GET /api/v1/activity failed: HTTP 401')
    const qv = screen.getByRole('region', { name: 'Quickvee rewards' })
    expect(within(qv).getByText('Not configured')).toBeInTheDocument()
    expect(within(qv).getByText('QUICKVEE_EMAIL, QUICKVEE_PASSWORD')).toBeInTheDocument()
    expect(within(qv).getByRole('button', { name: /Force re-sync/ })).toBeDisabled()
    expect(within(qv).getByText('Not scheduled')).toBeInTheDocument()
  })

  it('force re-sync starts a background run and polls live progress until it finishes', async () => {
    let state: 'idle' | 'running' | 'done' = 'idle'
    let polls = 0
    const calls = backend({
      'GET /api/sync': () => {
        if (state === 'running') polls++
        if (state === 'running' && polls > 2) state = 'done'
        const lastRun = state === 'idle' ? null : state === 'running' ? run({ status: 'running', finishedAt: null, durationMs: null, progress: { phase: 'Messages', done: 2, total: 5 } }) : run()
        return json(overview([src('twilio', 'Twilio', { lastRun })]))
      },
      'GET /api/sync/runs': () => json({ runs: [] }),
      'POST /api/sync/twilio/run': () => { state = 'running'; return json({ run: run({ status: 'running' }) }, 202) },
    })
    go('/data-sync')
    const card = await screen.findByRole('region', { name: 'Twilio' })
    expect(within(card).getByText('Never run')).toBeInTheDocument()
    fireEvent.click(within(card).getByRole('button', { name: /Force re-sync/ }))
    expect(await within(card).findByRole('status', { name: 'Twilio progress' })).toHaveTextContent('Messages · 2/5')
    expect(within(card).getByRole('button', { name: /Force re-sync/ })).toBeDisabled()
    await waitFor(() => expect(within(card).getByText('Up to date')).toBeInTheDocument(), { timeout: 8000 })
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(1)
  }, 15_000)

  it('shows a conflict when the job is already running', async () => {
    backend({
      'GET /api/sync': () => json(overview([src('email', 'Email tracking')])),
      'GET /api/sync/runs': () => json({ runs: [] }),
      'POST /api/sync/email/run': () => json({ error: 'Email tracking is already running', code: 'already_running' }, 409),
    })
    go('/data-sync')
    const card = await screen.findByRole('region', { name: 'Email tracking' })
    fireEvent.click(within(card).getByRole('button', { name: /Force re-sync/ }))
    expect(await within(card).findByText('Email tracking is already running')).toBeInTheDocument()
  })

  it('saves a schedule (frequency + local start date/time) and a Quickvee backfill range', async () => {
    const calls = backend({
      'GET /api/sync': () => json(overview([src('quickvee-orders', 'Quickvee orders')])),
      'GET /api/sync/runs': () => json({ runs: [] }),
      'PUT /api/sync/quickvee-orders/schedule': (init) => json({ schedule: { job: 'quickvee-orders', ...JSON.parse(String(init!.body)), nextRunAt: '2026-11-15T15:00:00.000Z' } }),
      'POST /api/sync/quickvee-orders/run': () => json({ run: run({ job: 'quickvee-orders', trigger: 'backfill', status: 'running' }) }, 202),
    })
    go('/data-sync')
    const card = await screen.findByRole('region', { name: 'Quickvee orders' })
    fireEvent.change(within(card).getByLabelText('Frequency'), { target: { value: 'weekly' } })
    fireEvent.change(within(card).getByLabelText('Quickvee orders start date'), { target: { value: '2026-11-15' } })
    fireEvent.change(within(card).getByLabelText('Quickvee orders start time'), { target: { value: '10:00' } })
    fireEvent.click(within(card).getByRole('button', { name: 'Save schedule' }))
    await waitFor(() => expect(calls.find(c => c.method === 'PUT')?.body).toEqual({ frequency: 'weekly', startLocal: '2026-11-15T10:00:00' }))

    const backfill = within(card).getByRole('group', { name: 'Backfill history' })
    const btn = within(backfill).getByRole('button', { name: /Backfill history/ })
    expect(btn).toBeDisabled()
    fireEvent.change(within(backfill).getByLabelText('From'), { target: { value: '2024-01-01' } })
    fireEvent.change(within(backfill).getByLabelText('To'), { target: { value: '2024-12-31' } })
    fireEvent.click(btn)
    await waitFor(() => expect(calls.find(c => c.method === 'POST')?.body).toEqual({ from: '2024-01-01', to: '2024-12-31' }))
    expect(await within(card).findByText('Backfill 2024-01-01 → 2024-12-31 started')).toBeInTheDocument()
  })

  it('run history expands to the log; timezone can be changed', async () => {
    const calls = backend({
      'GET /api/sync': () => json(overview([src('twilio', 'Twilio', { lastRun: run() })])),
      'GET /api/sync/runs': () => json({ runs: [run(), run({ id: 'r2', trigger: 'backfill', params: { from: '2026-01-01', to: '2026-02-01' }, status: 'failed', error: 'x' })] }),
      'GET /api/sync/runs/r1': () => json({ run: run({ log: [{ at: '2026-11-07T15:00:01.000Z', level: 'info', msg: 'Started Twilio' }, { at: '2026-11-07T15:00:40.000Z', level: 'warn', msg: 'Retry 1 in 500ms' }] }) }),
      'PUT /api/sync/timezone': (init) => json(JSON.parse(String(init!.body))),
    })
    go('/data-sync')
    const history = await screen.findByRole('region', { name: 'Run history' })
    expect(within(history).getByText('Backfill 2026-01-01 → 2026-02-01')).toBeInTheDocument()
    fireEvent.click(within(history).getAllByRole('button', { name: /Show log for Twilio run/ })[0])
    const log = await within(history).findByRole('list', { name: 'Run log' })
    expect(within(log).getByText(/Started Twilio/)).toBeInTheDocument()
    expect(within(log).getByText(/Retry 1 in 500ms/)).toBeInTheDocument()

    fireEvent.change(screen.getByRole('combobox', { name: 'Store timezone' }), { target: { value: 'America/Chicago' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save timezone' })) })
    await waitFor(() => expect(calls.find(c => c.method === 'PUT' && c.url.endsWith('/api/sync/timezone'))?.body).toEqual({ timezone: 'America/Chicago' }))
  })
})
