import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { ArrowLeft, Copy, Mail, RotateCcw, Trash2, UserPlus } from 'lucide-react'
import { api, type Invitation, type Role, type TeamMember } from '../api'
import { useAuth } from '../auth/AuthProvider'
import { Header } from '../components/Header'
import { navigate, ROUTES } from '../router'
import { canManageTeam, canModify, grantableRoles, relativeExpiry, ROLE_HELP, ROLE_LABEL } from './roles'

type Notice = { kind: 'ok' | 'err'; text: string; link?: string } | null
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function TeamPage() {
  const auth = useAuth()
  const me = auth.role
  const manage = canManageTeam(me)
  const [members, setMembers] = useState<TeamMember[] | null>(null)
  const [myId, setMyId] = useState<string | null>(null)
  const [invites, setInvites] = useState<Invitation[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [m, inv] = await Promise.all([api.team.members(), manage ? api.team.invitations() : Promise.resolve([])])
      setMembers(m.members); setMyId(m.me.userId); setInvites(inv); setLoadError(null)
    } catch (e) { setLoadError(message(e)) }
  }, [manage])
  useEffect(() => { void load() }, [load])

  async function run(key: string, fn: () => Promise<Notice | void>) {
    setBusy(key); setNotice(null)
    try {
      const n = await fn()
      if (n) setNotice(n)
      await load()
    } catch (e) {
      setNotice({ kind: 'err', text: message(e) })
    } finally { setBusy(null) }
  }

  const changeRole = (m: TeamMember, role: Role) => run(`role:${m.userId}`, async () => {
    if (m.userId === myId && !window.confirm(`Change your own role to ${ROLE_LABEL[role]}? You may lose access to team settings.`)) return
    await api.team.changeRole(m.userId, role)
    if (m.userId === myId) await auth.refresh()
    return { kind: 'ok', text: `${m.email ?? 'Member'} is now ${ROLE_LABEL[role]}.` }
  })

  const remove = (m: TeamMember) => run(`remove:${m.userId}`, async () => {
    const self = m.userId === myId
    if (!window.confirm(self ? 'Leave this organization? You will lose access until someone invites you again.'
      : `Remove ${m.email ?? 'this member'} from the team?`)) return
    await api.team.remove(m.userId)
    if (self) { await auth.refresh(); navigate(ROUTES.home); return }
    return { kind: 'ok', text: `${m.email ?? 'Member'} was removed.` }
  })

  const resend = (inv: Invitation) => run(`resend:${inv.id}`, async () => outcome(await api.team.resend(inv.id), inv.email, 'resent'))
  const revoke = (inv: Invitation) => run(`revoke:${inv.id}`, async () => {
    if (!window.confirm(`Revoke the invitation for ${inv.email}? The link will stop working.`)) return
    await api.team.revoke(inv.id)
    return { kind: 'ok', text: `Invitation for ${inv.email} revoked.` }
  })

  if (loadError && !members) {
    return (
      <div className="app"><Header />
        <div className="state" role="alert"><h2>Couldn't load your team</h2><p className="muted">{loadError}</p>
          <button className="btn-secondary" onClick={() => void load()}><RotateCcw size={16} /> Retry</button></div>
      </div>
    )
  }

  const org = auth.memberships.find(m => m.orgId === auth.orgId)
  return (
    <div className="app">
      <Header />
      <a className="back-link" href={ROUTES.home} onClick={e => { e.preventDefault(); navigate(ROUTES.home) }}>
        <ArrowLeft size={16} /> Back to outreach
      </a>
      <div className="page-title">
        <h2>Team</h2>
        <p className="muted">{org?.orgName ?? 'Your organization'} · you are {me ? ROLE_LABEL[me] : '—'}</p>
      </div>

      {notice && (
        <div className={`notice ${notice.kind}`} role={notice.kind === 'err' ? 'alert' : 'status'}>
          <span>{notice.text}</span>
          {notice.link && <CopyLink url={notice.link} />}
        </div>
      )}

      {manage && <InviteForm me={me} busy={busy === 'invite'} onInvite={(email, role) => run('invite', async () => outcome(await api.team.invite(email, role), email, 'sent'))} />}

      <section className="panel" aria-labelledby="members-h">
        <h3 id="members-h" className="eyebrow">Members {members && `(${members.length})`}</h3>
        {!members ? <p className="muted">Loading…</p> : (
          <ul className="rows">
            {members.map(m => {
              const self = m.userId === myId
              const editable = canModify(me, m.role)
              return (
                <li key={m.userId} className="row">
                  <div className="row-main">
                    <span className="avatar" aria-hidden>{(m.email ?? '?').slice(0, 1).toUpperCase()}</span>
                    <div>
                      <div className="row-title">{m.email ?? 'Unknown user'} {self && <span className="tag">You</span>}</div>
                      <div className="muted small">Joined {new Date(m.joinedAt).toLocaleDateString()}</div>
                    </div>
                  </div>
                  <div className="row-actions">
                    {editable ? (
                      <select aria-label={`Role for ${m.email ?? m.userId}`} className="role-select" value={m.role}
                        disabled={busy !== null} onChange={e => void changeRole(m, e.target.value as Role)}>
                        {[...new Set<Role>([...grantableRoles(me), m.role])].map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                      </select>
                    ) : <span className={`role-badge role-${m.role}`}>{ROLE_LABEL[m.role]}</span>}
                    {(self || editable) && (
                      <button className="icon-btn danger" disabled={busy !== null} onClick={() => void remove(m)}
                        aria-label={self ? 'Leave organization' : `Remove ${m.email ?? 'member'}`} title={self ? 'Leave' : 'Remove'}>
                        <Trash2 size={16} />
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {manage && (
        <section className="panel" aria-labelledby="invites-h">
          <h3 id="invites-h" className="eyebrow">Pending invitations {`(${invites.length})`}</h3>
          {invites.length === 0 ? <p className="muted small">No pending invitations.</p> : (
            <ul className="rows">
              {invites.map(inv => {
                const allowed = me === 'owner' || inv.role !== 'owner'
                return (
                  <li key={inv.id} className="row">
                    <div className="row-main">
                      <span className="avatar muted-avatar" aria-hidden><Mail size={15} /></span>
                      <div>
                        <div className="row-title">{inv.email} <span className={`role-badge role-${inv.role}`}>{ROLE_LABEL[inv.role]}</span></div>
                        <div className={`small ${inv.status === 'expired' ? 'error' : 'muted'}`}>
                          {relativeExpiry(inv.expiresAt)} · sent {inv.sendCount}×
                        </div>
                      </div>
                    </div>
                    {allowed && (
                      <div className="row-actions">
                        <button className="btn-small" disabled={busy !== null} onClick={() => void resend(inv)} aria-label={`Resend invitation to ${inv.email}`}>
                          Resend
                        </button>
                        <button className="btn-small danger" disabled={busy !== null} onClick={() => void revoke(inv)} aria-label={`Revoke invitation to ${inv.email}`}>
                          Revoke
                        </button>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}

function outcome(r: { emailSent: boolean; acceptUrl?: string }, email: string, verb: 'sent' | 'resent'): Notice {
  if (r.emailSent) return { kind: 'ok', text: `Invitation ${verb} to ${email}.` }
  if (r.acceptUrl) return { kind: 'ok', text: `Email delivery is off in development. Share this link with ${email}:`, link: r.acceptUrl }
  return { kind: 'err', text: `The invitation was saved, but the email to ${email} failed to send. Try “Resend”.` }
}

function InviteForm({ me, busy, onInvite }: { me: Role | null; busy: boolean; onInvite: (email: string, role: Role) => Promise<void> }) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('staff')
  const roles = grantableRoles(me)
  async function submit(e: FormEvent) {
    e.preventDefault()
    await onInvite(email.trim(), role)
    setEmail('')
  }
  return (
    <form className="panel invite-form" onSubmit={submit} aria-label="Invite a teammate">
      <h3 className="eyebrow"><UserPlus size={14} aria-hidden /> Invite a teammate</h3>
      <div className="invite-fields">
        <input type="email" required maxLength={320} placeholder="name@store.com" aria-label="Email address"
          value={email} onChange={e => setEmail(e.target.value)} />
        <select aria-label="Role" className="role-select" value={role} onChange={e => setRole(e.target.value as Role)}>
          {roles.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </select>
        <button className="btn-primary" type="submit" disabled={busy || !email.trim()}>{busy ? 'Sending…' : 'Send invite'}</button>
      </div>
      <p className="muted small">{ROLE_HELP[role]}. Invitations expire after 7 days.</p>
    </form>
  )
}

function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <span className="copy-link">
      <input readOnly value={url} aria-label="Invitation link" onFocus={e => e.currentTarget.select()} />
      <button type="button" className="btn-small" onClick={() => {
        void navigator.clipboard?.writeText(url).then(() => setCopied(true), () => setCopied(false))
      }}><Copy size={14} /> {copied ? 'Copied' : 'Copy'}</button>
    </span>
  )
}

