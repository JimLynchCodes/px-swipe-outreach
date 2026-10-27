import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { api, configureApi, type Membership } from '../api'
import type { AuthConfig } from './supabase'

type Status = 'loading' | 'signedOut' | 'signedIn' | 'error'

interface AuthState {
  mode: AuthConfig['mode']
  status: Status
  error: string | null
  email: string | null
  memberships: Membership[]
  orgId: string | null
  setOrgId: (id: string) => void
  /** Role in the selected org. */
  role: Membership['role'] | null
  client: SupabaseClient | null
  signOut: () => Promise<void>
  /** Reload identity + memberships (e.g. after accepting an invitation). */
  refresh: () => Promise<Membership[]>
}

const Ctx = createContext<AuthState | null>(null)
const ORG_KEY = 'outreach.orgId'

/** Null outside the provider (e.g. isolated component tests). */
export function useOptionalAuth(): AuthState | null { return useContext(Ctx) }

export function useAuth(): AuthState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>')
  return v
}

export function AuthProvider({ config, children }: { config: AuthConfig; children: ReactNode }) {
  const client = config.mode === 'supabase' ? config.client : null
  const [session, setSession] = useState<Session | null>(null)
  const [status, setStatus] = useState<Status>(config.mode === 'misconfigured' ? 'error' : 'loading')
  const [error, setError] = useState<string | null>(config.mode === 'misconfigured' ? config.reason : null)
  const [memberships, setMemberships] = useState<Membership[]>([])
  const [email, setEmail] = useState<string | null>(null)
  const [orgId, setOrgIdState] = useState<string | null>(null)

  const signOut = useCallback(async () => {
    if (client) await client.auth.signOut().catch(() => {})
    localStorage.removeItem(ORG_KEY)
    setSession(null); setMemberships([]); setOrgIdState(null); setEmail(null)
    setStatus(client ? 'signedOut' : 'loading')
  }, [client])

  // Wire the API client to the current session/org on every render cycle.
  useEffect(() => {
    configureApi({
      getToken: async () => (client ? (await client.auth.getSession()).data.session?.access_token ?? null : null),
      getOrgId: () => orgId,
      onUnauthorized: () => { if (client) void signOut() },
    })
  }, [client, orgId, signOut])

  // Track the Supabase session (supabase-js refreshes tokens automatically).
  useEffect(() => {
    if (!client) { if (config.mode === 'demo') setStatus('loading'); return }
    let alive = true
    void adoptHashSession(client).then(() => client.auth.getSession())
      .then(({ data }) => { if (alive) { setSession(data.session); if (!data.session) setStatus('signedOut') } })
    const { data } = client.auth.onAuthStateChange((_event, s) => {
      setSession(s)
      if (!s) setStatus('signedOut')
    })
    return () => { alive = false; data.subscription.unsubscribe() }
  }, [client, config.mode])

  // Load identity + memberships once we have a session (or in demo mode).
  const userKey = client ? session?.user.id ?? null : 'demo'
  useEffect(() => {
    if (!userKey || config.mode === 'misconfigured') return
    let alive = true
    setStatus('loading')
    api.me().then(me => {
      if (!alive) return
      setEmail(me.user.email ?? null)
      setMemberships(me.memberships)
      const saved = localStorage.getItem(ORG_KEY)
      const pick = me.memberships.find(m => m.orgId === saved) ?? me.memberships[0]
      setOrgIdState(pick?.orgId ?? null)
      setStatus('signedIn'); setError(null)
    }).catch(e => {
      if (!alive) return
      setError(e instanceof Error ? e.message : String(e)); setStatus('error')
    })
    return () => { alive = false }
  }, [userKey, config.mode])

  const refresh = useCallback(async () => {
    const me = await api.me()
    setEmail(me.user.email ?? null)
    setMemberships(me.memberships)
    return me.memberships
  }, [])

  // If the selected org disappears (e.g. you left it), fall back to another one.
  useEffect(() => {
    if (status === 'signedIn' && orgId && !memberships.some(m => m.orgId === orgId)) {
      setOrgIdState(memberships[0]?.orgId ?? null)
    }
  }, [status, orgId, memberships])

  const setOrgId = useCallback((id: string) => { localStorage.setItem(ORG_KEY, id); setOrgIdState(id) }, [])

  const role = memberships.find(m => m.orgId === orgId)?.role ?? null
  const value = useMemo<AuthState>(() => ({
    mode: config.mode, status, error, email, memberships, orgId, setOrgId, role, client, signOut, refresh,
  }), [config.mode, status, error, email, memberships, orgId, setOrgId, role, client, signOut, refresh])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/**
 * Supabase "invite user" and admin-sent magic links redirect with tokens in the URL hash (implicit flow),
 * which a PKCE client refuses to read. Adopt them explicitly, then scrub them from the address bar.
 */
export async function adoptHashSession(client: SupabaseClient): Promise<void> {
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : ''
  if (!hash.includes('access_token=')) return
  const p = new URLSearchParams(hash)
  const access_token = p.get('access_token')
  const refresh_token = p.get('refresh_token')
  window.history.replaceState(null, '', window.location.pathname + window.location.search)
  if (access_token && refresh_token) await client.auth.setSession({ access_token, refresh_token }).catch(() => undefined)
}
