import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import Root from '../Root'
import { assertPublicKey } from './supabase'

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }))
const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '')

function fakeClient(session: { access_token: string; user: { id: string } } | null) {
  let listener: ((e: string, s: unknown) => void) | null = null
  const client = {
    auth: {
      getSession: vi.fn(async () => ({ data: { session } })),
      onAuthStateChange: vi.fn((cb: (e: string, s: unknown) => void) => { listener = cb; return { data: { subscription: { unsubscribe: () => {} } } } }),
      signInWithPassword: vi.fn(async () => ({ error: null })),
      signInWithOtp: vi.fn(async () => ({ error: null })),
      signUp: vi.fn(async () => ({ error: null, data: { session: null } })),
      signOut: vi.fn(async () => { session = null; listener?.('SIGNED_OUT', null); return { error: null } }),
    },
  }
  return client as unknown as SupabaseClient & { auth: typeof client.auth }
}

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear() })

describe('auth gate', () => {
  it('shows the login page when signed out and signs in with a password', async () => {
    const client = fakeClient(null)
    vi.stubGlobal('fetch', vi.fn(() => json({ error: 'no' }, 401)))
    render(<Root config={{ mode: 'supabase', client }} />)
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'a@b.co' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter22!' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(client.auth.signInWithPassword).toHaveBeenCalledWith({ email: 'a@b.co', password: 'hunter22!' }))
  })

  it('sends a magic link without creating users', async () => {
    const client = fakeClient(null)
    render(<Root config={{ mode: 'supabase', client }} />)
    fireEvent.click(await screen.findByText('Email me a magic link'))
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.co' } })
    fireEvent.click(screen.getByRole('button', { name: 'Email me a link' }))
    expect(await screen.findByText(/Check your email/)).toBeInTheDocument()
    expect(client.auth.signInWithOtp).toHaveBeenCalledWith(expect.objectContaining({ email: 'a@b.co', options: expect.objectContaining({ shouldCreateUser: false }) }))
  })

  it('attaches the bearer token and org header, and signs out on 401', async () => {
    const client = fakeClient({ access_token: 'tok123', user: { id: 'u1' } })
    const seen: Headers[] = []
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers))
      if (url.endsWith('/api/me')) return json({ user: { id: 'u1', email: 'a@b.co' }, memberships: [{ orgId: 'org-1', orgName: 'Acme', businessName: 'Acme', role: 'owner' }], authMode: 'supabase' })
      return json({ error: 'Token expired', code: 'unauthenticated' }, 401)
    }))
    render(<Root config={{ mode: 'supabase', client }} />)
    await waitFor(() => expect(client.auth.signOut).toHaveBeenCalled())
    expect(seen[0].get('authorization')).toBe('Bearer tok123')
    const queueCall = seen.find(h => h.get('x-org-id'))
    expect(queueCall?.get('x-org-id')).toBe('org-1')
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('explains when the user has no organization', async () => {
    const client = fakeClient({ access_token: 't', user: { id: 'u1' } })
    vi.stubGlobal('fetch', vi.fn(() => json({ user: { id: 'u1', email: 'a@b.co' }, memberships: [], authMode: 'supabase' })))
    render(<Root config={{ mode: 'supabase', client }} />)
    expect(await screen.findByText('No store access yet')).toBeInTheDocument()
  })

  it('refuses to start when misconfigured', () => {
    render(<Root config={{ mode: 'misconfigured', reason: 'VITE_SUPABASE_URL is not set' }} />)
    expect(screen.getByRole('alert')).toHaveTextContent('VITE_SUPABASE_URL is not set')
  })
})

describe('assertPublicKey', () => {
  it('rejects service_role and secret keys, accepts anon', () => {
    expect(() => assertPublicKey(`h.${b64({ role: 'service_role' })}.s`)).toThrow(/service_role/)
    expect(() => assertPublicKey('sb_secret_abc')).toThrow(/secret/)
    expect(() => assertPublicKey(`h.${b64({ role: 'anon' })}.s`)).not.toThrow()
    expect(() => assertPublicKey('sb_publishable_abc')).not.toThrow()
  })
})
