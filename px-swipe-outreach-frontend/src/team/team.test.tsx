import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import Root from '../Root'
import { canModify, grantableRoles, relativeExpiry } from './roles'

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }))
const TOKEN = 'A'.repeat(43)

function fakeClient(session: { access_token: string; user: { id: string } } | null) {
  const client = {
    auth: {
      getSession: vi.fn(async () => ({ data: { session } })),
      setSession: vi.fn(async () => ({ data: {}, error: null })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: () => {} } } })),
      signInWithPassword: vi.fn(async () => ({ error: null })),
      signInWithOtp: vi.fn(async () => ({ error: null })),
      signUp: vi.fn(async () => ({ error: null, data: { session: null } })),
      signOut: vi.fn(async () => ({ error: null })),
    },
  }
  return client as unknown as SupabaseClient & { auth: typeof client.auth }
}

const ORG = { orgId: 'org-1', orgName: 'Acme', businessName: 'Acme', role: 'owner' as const }
type Call = { url: string; method: string; body: unknown }

/** Fake backend keyed by "METHOD path". */
function backend(routes: Record<string, (c: Call) => Promise<Response>>) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '')
    const c = { url: path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined }
    calls.push(c)
    const key = Object.keys(routes).find(k => { const [m, p] = k.split(' '); return m === c.method && (p.endsWith('*') ? path.startsWith(p.slice(0, -1)) : path.split('?')[0] === p) })
    return key ? routes[key](c) : json({ error: 'not found' }, 404)
  }))
  return calls
}

const members = (myRole: 'owner' | 'admin' | 'staff') => ({
  me: { userId: 'u-me', role: myRole },
  members: [
    { userId: 'u-own', email: 'owner@acme.test', role: 'owner', joinedAt: '2026-01-01T00:00:00Z' },
    { userId: 'u-me', email: 'me@acme.test', role: myRole, joinedAt: '2026-02-01T00:00:00Z' },
    { userId: 'u-st', email: 'staff@acme.test', role: 'staff', joinedAt: '2026-03-01T00:00:00Z' },
  ].filter((m, i, a) => a.findIndex(x => x.userId === m.userId) === i),
})
const pending = [{ id: 'inv-1', orgId: 'org-1', email: 'new@acme.test', role: 'admin', status: 'pending', invitedBy: 'u-me',
  createdAt: '2026-10-26T00:00:00Z', expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString(), lastSentAt: '2026-10-26T00:00:00Z', sendCount: 1 }]

const me = (role: 'owner' | 'admin' | 'staff', email = 'me@acme.test', memberships = [{ ...ORG, role }]) =>
  () => json({ user: { id: 'u-me', email }, memberships, authMode: 'supabase' })

beforeEach(() => { window.history.replaceState(null, '', '/team') })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, '', '/') })

describe('role helpers', () => {
  it('mirror the backend rules', () => {
    expect(grantableRoles('owner')).toEqual(['staff', 'admin', 'owner'])
    expect(grantableRoles('admin')).toEqual(['staff', 'admin'])
    expect(grantableRoles('staff')).toEqual([])
    expect(canModify('admin', 'owner')).toBe(false)
    expect(canModify('admin', 'staff')).toBe(true)
    expect(relativeExpiry(new Date(Date.now() - 1).toISOString())).toBe('Expired')
  })
})

describe('Team page', () => {
  it('owner sees members, pending invites, and can invite with any role', async () => {
    const calls = backend({
      'GET /api/me': me('owner'),
      'GET /api/team/members': () => json(members('owner')),
      'GET /api/team/invitations': () => json({ invitations: pending }),
      'POST /api/team/invitations': c => json({ invitation: { ...pending[0], email: (c.body as { email: string }).email }, emailSent: true }, 201),
    })
    render(<Root config={{ mode: 'supabase', client: fakeClient({ access_token: 't', user: { id: 'u-me' } }) }} />)
    expect(await screen.findByText('staff@acme.test')).toBeInTheDocument()
    expect(screen.getByText('new@acme.test')).toBeInTheDocument()
    const form = screen.getByRole('form', { name: 'Invite a teammate' })
    expect(within(form).getAllByRole('option').map(o => o.textContent)).toEqual(['Staff', 'Admin', 'Owner'])
    fireEvent.change(within(form).getByLabelText('Email address'), { target: { value: 'hire@acme.test' } })
    fireEvent.change(within(form).getByLabelText('Role'), { target: { value: 'admin' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Send invite' }))
    expect(await screen.findByText('Invitation sent to hire@acme.test.')).toBeInTheDocument()
    expect(calls.find(c => c.method === 'POST')?.body).toEqual({ email: 'hire@acme.test', role: 'admin' })
    expect(calls.find(c => c.url === '/api/team/members')).toBeTruthy()
  })

  it('shows the dev share link when email delivery is off, and surfaces API errors', async () => {
    let n = 0
    backend({
      'GET /api/me': me('owner'),
      'GET /api/team/members': () => json(members('owner')),
      'GET /api/team/invitations': () => json({ invitations: [] }),
      'POST /api/team/invitations': () => (n++ === 0
        ? json({ invitation: pending[0], emailSent: false, acceptUrl: `http://localhost:5173/invite/accept?token=${TOKEN}` }, 201)
        : json({ error: 'An invitation is already pending for that email', code: 'already_invited' }, 409)),
    })
    render(<Root config={{ mode: 'supabase', client: fakeClient({ access_token: 't', user: { id: 'u-me' } }) }} />)
    const input = await screen.findByLabelText('Email address')
    fireEvent.change(input, { target: { value: 'x@acme.test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }))
    expect(await screen.findByLabelText('Invitation link')).toHaveValue(`http://localhost:5173/invite/accept?token=${TOKEN}`)
    fireEvent.change(input, { target: { value: 'x@acme.test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('already pending')
  })

  it('admin cannot grant owner or edit owners; resend and revoke call the API', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const calls = backend({
      'GET /api/me': me('admin'),
      'GET /api/team/members': () => json(members('admin')),
      'GET /api/team/invitations': () => json({ invitations: pending }),
      'POST /api/team/invitations/inv-1/resend': () => json({ invitation: pending[0], emailSent: true }),
      'DELETE /api/team/invitations/inv-1': () => json({ ok: true }),
      'PATCH /api/team/members/u-st': () => json({ ok: true }),
    })
    render(<Root config={{ mode: 'supabase', client: fakeClient({ access_token: 't', user: { id: 'u-me' } }) }} />)
    await screen.findByText('staff@acme.test')
    expect(within(screen.getByRole('form', { name: 'Invite a teammate' })).queryByRole('option', { name: 'Owner' })).toBeNull()
    expect(screen.queryByLabelText('Role for owner@acme.test')).toBeNull()
    expect(screen.queryByLabelText('Remove owner@acme.test')).toBeNull()
    fireEvent.change(screen.getByLabelText('Role for staff@acme.test'), { target: { value: 'admin' } })
    expect(await screen.findByText('staff@acme.test is now Admin.')).toBeInTheDocument()
    expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({ role: 'admin' })
    fireEvent.click(screen.getByLabelText('Resend invitation to new@acme.test'))
    expect(await screen.findByText('Invitation resent to new@acme.test.')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Revoke invitation to new@acme.test'))
    expect(await screen.findByText('Invitation for new@acme.test revoked.')).toBeInTheDocument()
  })

  it('staff see a read-only roster and can only leave', async () => {
    const calls = backend({ 'GET /api/me': me('staff'), 'GET /api/team/members': () => json(members('staff')) })
    render(<Root config={{ mode: 'supabase', client: fakeClient({ access_token: 't', user: { id: 'u-me' } }) }} />)
    await screen.findByText('staff@acme.test')
    expect(screen.queryByRole('form', { name: 'Invite a teammate' })).toBeNull()
    expect(screen.queryByText(/Pending invitations/)).toBeNull()
    expect(screen.queryAllByRole('combobox')).toHaveLength(0)
    expect(screen.getByLabelText('Leave organization')).toBeInTheDocument()
    expect(calls.some(c => c.url.startsWith('/api/team/invitations'))).toBe(false)
  })

  it('shows the last-owner error from the server', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    backend({
      'GET /api/me': me('owner'),
      'GET /api/team/members': () => json(members('owner')),
      'GET /api/team/invitations': () => json({ invitations: [] }),
      'DELETE /api/team/members/u-own': () => json({ error: 'An organization must keep at least one owner.', code: 'last_owner' }, 409),
    })
    render(<Root config={{ mode: 'supabase', client: fakeClient({ access_token: 't', user: { id: 'u-me' } }) }} />)
    fireEvent.click(await screen.findByLabelText('Remove owner@acme.test'))
    expect(await screen.findByRole('alert')).toHaveTextContent('at least one owner')
  })
})

describe('Accept invitation page', () => {
  const preview = (status = 'pending') => () => json({ invitation: { orgName: 'Acme', email: 'new@acme.test', role: 'admin', status, expiresAt: '2026-11-02T00:00:00Z' } })

  it('signed out: explains the invite and sends a magic link back to the accept URL (account creation allowed)', async () => {
    window.history.replaceState(null, '', `/invite/accept?token=${TOKEN}`)
    const client = fakeClient(null)
    const calls = backend({ 'GET /api/invitations/preview': preview() })
    render(<Root config={{ mode: 'supabase', client }} />)
    expect(await screen.findByText(/invited to join/)).toBeInTheDocument()
    expect(screen.getByLabelText('Email')).toHaveValue('new@acme.test')
    fireEvent.click(screen.getByRole('button', { name: 'Email me a link' }))
    await waitFor(() => expect(client.auth.signInWithOtp).toHaveBeenCalledWith({
      email: 'new@acme.test',
      options: { emailRedirectTo: `${window.location.origin}/invite/accept?token=${TOKEN}`, shouldCreateUser: true },
    }))
    expect(new Headers((vi.mocked(fetch).mock.calls[0][1] as RequestInit).headers).get('authorization')).toBeNull()
    expect(calls[0].url).toBe(`/api/invitations/preview?token=${TOKEN}`)
    expect(sessionStorage.getItem('outreach.inviteToken')).toBe(TOKEN)
  })

  it('signed in with no org yet: accepts, refreshes memberships, selects the org and goes home', async () => {
    window.history.replaceState(null, '', `/invite/accept?token=${TOKEN}`)
    let joined = false
    const calls = backend({
      'GET /api/invitations/preview': preview(),
      'GET /api/me': () => json({ user: { id: 'u-new', email: 'New@Acme.test' }, memberships: joined ? [{ ...ORG, role: 'admin' }] : [], authMode: 'supabase' }),
      'POST /api/invitations/accept': () => { joined = true; return json({ ok: true, orgId: 'org-1', role: 'admin', alreadyMember: false, memberships: [] }) },
      'GET /api/outreach/queue': () => json({ items: [], total: 0 }),
    })
    render(<Root config={{ mode: 'supabase', client: fakeClient({ access_token: 't', user: { id: 'u-new' } }) }} />)
    fireEvent.click(await screen.findByRole('button', { name: /Accept invitation/ }))
    await waitFor(() => expect(window.location.pathname).toBe('/'))
    expect(calls.find(c => c.method === 'POST')?.body).toEqual({ token: TOKEN })
    expect(localStorage.getItem('outreach.orgId')).toBe('org-1')
    expect(sessionStorage.getItem('outreach.inviteToken')).toBeNull()
  })

  it('warns when signed in as a different email instead of offering accept', async () => {
    window.history.replaceState(null, '', `/invite/accept?token=${TOKEN}`)
    backend({ 'GET /api/invitations/preview': preview(), 'GET /api/me': me('owner', 'someone@else.test') })
    render(<Root config={{ mode: 'supabase', client: fakeClient({ access_token: 't', user: { id: 'u-me' } }) }} />)
    expect(await screen.findByRole('alert')).toHaveTextContent("you're signed in as someone@else.test")
    expect(screen.queryByRole('button', { name: /Accept invitation/ })).toBeNull()
  })

  it.each([
    ['expired', 'This invitation has expired'],
    ['revoked', 'This invitation was revoked'],
    ['accepted', 'already used'],
  ])('shows the %s state', async (status, text) => {
    window.history.replaceState(null, '', `/invite/accept?token=${TOKEN}`)
    backend({ 'GET /api/invitations/preview': preview(status) })
    render(<Root config={{ mode: 'supabase', client: fakeClient(null) }} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(text)
  })

  it('handles missing/unknown tokens', async () => {
    window.history.replaceState(null, '', '/invite/accept?token=nope')
    backend({})
    render(<Root config={{ mode: 'supabase', client: fakeClient(null) }} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Invitation link not valid')
  })

  it('adopts implicit-flow tokens from an invite email link and scrubs them from the URL', async () => {
    window.history.replaceState(null, '', `/invite/accept?token=${TOKEN}#access_token=at&refresh_token=rt&type=invite`)
    const client = fakeClient(null)
    backend({ 'GET /api/invitations/preview': preview() })
    render(<Root config={{ mode: 'supabase', client }} />)
    await waitFor(() => expect(client.auth.setSession).toHaveBeenCalledWith({ access_token: 'at', refresh_token: 'rt' }))
    expect(window.location.hash).toBe('')
    expect(window.location.search).toBe(`?token=${TOKEN}`)
  })
})
