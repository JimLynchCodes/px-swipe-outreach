/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string
  readonly VITE_SUPABASE_URL?: string
  /** The publishable key (sb_publishable_…), never a secret key. Takes precedence over the legacy alias below. */
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string
  /** Legacy alias: the old anon JWT. */
  readonly VITE_SUPABASE_ANON_KEY?: string
  readonly VITE_DEMO_MODE?: string
}
