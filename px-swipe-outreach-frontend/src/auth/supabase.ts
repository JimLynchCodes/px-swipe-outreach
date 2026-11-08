import { createClient, type SupabaseClient } from '@supabase/supabase-js'


/** Refuse obviously-privileged keys so a service_role key can never ship in the bundle. */
export function assertPublicKey(k: string): void {
  if (k.startsWith('sb_secret_')) throw new Error('The Supabase key is a secret key (sb_secret_). Use the publishable key (sb_publishable_) or the legacy anon key.')
  const parts = k.split('.')
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
      if (payload?.role === 'service_role') throw new Error('The Supabase key is the service_role key. Use the publishable key (sb_publishable_).')
    } catch (e) {
      if (e instanceof Error && e.message.includes('service_role')) throw e
    }
  }
}

export type AuthConfig =
  | { mode: 'supabase'; client: SupabaseClient }
  | { mode: 'demo' }
  | { mode: 'misconfigured'; reason: string }

export function resolveAuthConfig(): AuthConfig {
  const url = import.meta.env.VITE_SUPABASE_URL?.trim()
  // Either the new publishable key (sb_publishable_…) or the legacy anon JWT. VITE_SUPABASE_PUBLISHABLE_KEY is an alias.
  const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY)?.trim()
  const demoAllowed = import.meta.env.DEV || import.meta.env.VITE_DEMO_MODE === 'true'
  if (url && key) {
    try { assertPublicKey(key) } catch (e) { return { mode: 'misconfigured', reason: (e as Error).message } }
    return {
      mode: 'supabase',
      client: createClient(url, key, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
      }),
    }
  }
  if (demoAllowed) return { mode: 'demo' }
  return { mode: 'misconfigured', reason: 'VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY (legacy: VITE_SUPABASE_ANON_KEY) are not set for this build.' }
}
