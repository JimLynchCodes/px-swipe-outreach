import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL?.trim()
const key = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim()

/** Refuse obviously-privileged keys so a service_role key can never ship in the bundle. */
export function assertPublicKey(k: string): void {
  if (k.startsWith('sb_secret_')) throw new Error('VITE_SUPABASE_ANON_KEY is a secret key. Use the anon/publishable key.')
  const parts = k.split('.')
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
      if (payload?.role === 'service_role') throw new Error('VITE_SUPABASE_ANON_KEY is the service_role key. Use the anon key.')
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
  return { mode: 'misconfigured', reason: 'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are not set for this build.' }
}
