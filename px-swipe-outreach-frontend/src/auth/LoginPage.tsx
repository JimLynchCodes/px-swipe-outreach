import { useState, type FormEvent } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'

type Mode = 'password' | 'magic' | 'signup'

type Props = {
  client: SupabaseClient
  /** Where email links should land (defaults to the app root). */
  redirectTo?: string
  /** Prefill (and lock) the email, e.g. for an invitation. */
  email?: string
  /** Allow magic links to create the account (invited users may not have one yet). */
  allowCreate?: boolean
  title?: string
  subtitle?: string
  initialMode?: Mode
}

export function LoginPage({ client, redirectTo: redirect, email: fixedEmail, allowCreate = false, title, subtitle, initialMode }: Props) {
  const [mode, setMode] = useState<Mode>(initialMode ?? 'password')
  const [email, setEmail] = useState(fixedEmail ?? '')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const redirectTo = redirect ?? `${window.location.origin}/`

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setMsg(null)
    try {
      if (mode === 'magic') {
        const { error } = await client.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo, shouldCreateUser: allowCreate } })
        if (error) throw error
        setMsg({ kind: 'ok', text: 'Check your email for a sign-in link.' })
      } else if (mode === 'signup') {
        const { error, data } = await client.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo } })
        if (error) throw error
        if (!data.session) setMsg({ kind: 'ok', text: 'Check your email to confirm your account.' })
      } else {
        const { error } = await client.auth.signInWithPassword({ email, password })
        if (error) throw error
      }
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : String(err) })
    } finally { setBusy(false) }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit} aria-label="Sign in">
        <div className="brand">
          <img src="/flame.svg" alt="" className="brand-logo" width={36} height={36} />
          <div><h1>{title ?? 'Outreach'}</h1><p>{subtitle ?? (mode === 'signup' ? 'Create your account' : 'Sign in to continue')}</p></div>
        </div>
        <label>Email
          <input type="email" required autoComplete="email" value={email} readOnly={!!fixedEmail} onChange={e => setEmail(e.target.value)} />
        </label>
        {mode !== 'magic' && (
          <label>Password
            <input type="password" required minLength={8} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              value={password} onChange={e => setPassword(e.target.value)} />
          </label>
        )}
        <button className="btn-primary" type="submit" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'magic' ? 'Email me a link' : mode === 'signup' ? 'Create account' : 'Sign in'}
        </button>
        {msg && <p className={msg.kind === 'err' ? 'error' : 'muted'} role={msg.kind === 'err' ? 'alert' : 'status'}>{msg.text}</p>}
        <div className="login-links">
          {mode !== 'password' && <button type="button" className="link" onClick={() => setMode('password')}>Use password</button>}
          {mode !== 'magic' && <button type="button" className="link" onClick={() => setMode('magic')}>Email me a magic link</button>}
          {mode !== 'signup' && <button type="button" className="link" onClick={() => setMode('signup')}>Create an account</button>}
        </div>
      </form>
    </div>
  )
}
