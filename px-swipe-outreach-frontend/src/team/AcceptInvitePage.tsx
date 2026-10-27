import { useEffect, useState } from 'react'
import { CheckCircle2, MailWarning } from 'lucide-react'
import { api, ApiError, type InvitationPreview } from '../api'
import { useAuth } from '../auth/AuthProvider'
import { LoginPage } from '../auth/LoginPage'
import { navigate, ROUTES } from '../router'
import { ROLE_LABEL } from './roles'

const TOKEN_KEY = 'outreach.inviteToken'
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

/** Token from ?token=, remembered for this tab so it survives a sign-in round trip. */
function readToken(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get('token')
  if (fromUrl && TOKEN_RE.test(fromUrl)) { sessionStorage.setItem(TOKEN_KEY, fromUrl); return fromUrl }
  const saved = sessionStorage.getItem(TOKEN_KEY)
  return saved && TOKEN_RE.test(saved) ? saved : null
}

type Preview = { state: 'loading' } | { state: 'invalid'; reason: string } | { state: 'ok'; inv: InvitationPreview }

const STATUS_TEXT: Record<string, { title: string; body: string }> = {
  expired: { title: 'This invitation has expired', body: 'Ask a team owner or admin to send you a new one.' },
  revoked: { title: 'This invitation was revoked', body: 'Ask a team owner or admin if you still need access.' },
  accepted: { title: 'This invitation was already used', body: 'If it was you, just sign in and open the app.' },
  invalid: { title: 'Invitation link not valid', body: 'The link may be incomplete or was replaced by a newer invitation. Check your latest email.' },
}

export function AcceptInvitePage() {
  const auth = useAuth()
  const [token] = useState(readToken)
  const [preview, setPreview] = useState<Preview>({ state: 'loading' })
  const [accepting, setAccepting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!token) { setPreview({ state: 'invalid', reason: 'invalid' }); return }
    let alive = true
    api.invitations.preview(token)
      .then(inv => { if (alive) setPreview({ state: 'ok', inv }) })
      .catch(e => { if (alive) setPreview(e instanceof ApiError && (e.status === 404 || e.status === 400) ? { state: 'invalid', reason: 'invalid' } : { state: 'invalid', reason: e instanceof Error ? e.message : 'error' }) })
    return () => { alive = false }
  }, [token])

  const finish = (orgId: string) => {
    sessionStorage.removeItem(TOKEN_KEY)
    auth.setOrgId(orgId)
    navigate(ROUTES.home, { replace: true })
  }

  async function accept() {
    if (!token) return
    setAccepting(true); setError(null)
    try {
      const r = await api.invitations.accept(token)
      await auth.refresh()
      finish(r.orgId)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setAccepting(false)
    }
  }

  if (preview.state === 'loading') return <div className="state full">Checking your invitation…</div>

  if (preview.state === 'invalid' || preview.inv.status !== 'pending') {
    const key = preview.state === 'ok' ? preview.inv.status : preview.reason
    const text = STATUS_TEXT[key] ?? { title: 'Something went wrong', body: key }
    return (
      <div className="login">
        <div className="login-card" role="alert">
          <MailWarning size={28} className="error" aria-hidden />
          <h2>{text.title}</h2>
          <p className="muted">{text.body}</p>
          <button className="btn-secondary" onClick={() => { sessionStorage.removeItem(TOKEN_KEY); navigate(ROUTES.home, { replace: true }) }}>Go to the app</button>
        </div>
      </div>
    )
  }

  const inv = preview.inv
  const intro = <>You've been invited to join <strong>{inv.orgName}</strong> as <strong>{ROLE_LABEL[inv.role]}</strong>.</>

  if (auth.status === 'signedOut' && auth.client) {
    return (
      <div className="invite-wrap">
        <p className="invite-intro">{intro} Sign in or create an account with <strong>{inv.email}</strong> to accept.</p>
        <LoginPage client={auth.client} email={inv.email} allowCreate initialMode="magic"
          redirectTo={`${window.location.origin}${ROUTES.acceptInvite}?token=${encodeURIComponent(token!)}`}
          title={`Join ${inv.orgName}`} subtitle="Sign in to accept your invitation" />
      </div>
    )
  }
  if (auth.status !== 'signedIn') return <div className="state full">Loading…</div>

  const mismatch = !auth.email || auth.email.toLowerCase() !== inv.email.toLowerCase()

  return (
    <div className="login">
      <div className="login-card">
        <div className="brand">
          <img src="/flame.svg" alt="" className="brand-logo" width={36} height={36} />
          <div><h1>Join {inv.orgName}</h1><p>Team invitation</p></div>
        </div>
        <p>{intro}</p>
        {mismatch ? (
          <div role="alert" className="notice err">
            This invitation is for <strong>{inv.email}</strong>, but you're signed in as <strong>{auth.email ?? 'an account without an email'}</strong>.
            Sign out and sign in with the invited address.
          </div>
        ) : (
          <button className="btn-primary" onClick={() => void accept()} disabled={accepting}>
            {accepting ? 'Joining…' : <><CheckCircle2 size={16} aria-hidden /> Accept invitation</>}
          </button>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="login-links">
          {auth.mode === 'supabase' && <button type="button" className="link" onClick={() => void auth.signOut()}>Sign out</button>}
          <button type="button" className="link" onClick={() => navigate(ROUTES.home)}>Not now</button>
        </div>
        <p className="muted small">Expires {new Date(inv.expiresAt).toLocaleString()}</p>
      </div>
    </div>
  )
}
