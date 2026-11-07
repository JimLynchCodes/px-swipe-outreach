import { Fragment, useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Mail, MessageCircle, Search, Send } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { api } from '../api'
import { PageShell } from '../components/PageShell'
import type { Channel, ConsentEvent, ConsentSource, OptOutEntry, OptOutSource } from '../types'

const SOURCE_LABEL: Record<OptOutSource, string> = { sms_stop: 'STOP reply', email_unsubscribe: 'Unsubscribe link', manual: 'Manual', provider: 'Bounce/complaint' }
const CONSENT_SOURCE: Record<ConsentSource, string> = {
  ...SOURCE_LABEL, sms_start: 'START/JOIN reply', email_resubscribe: 'Resubscribe button', reoptin_link: 'Re-opt-in link', store_request: 'Store request',
}
const EVENT_LABEL: Record<ConsentEvent['event'], string> = { opt_out: 'Opted out', opt_in: 'Opted back in', reoptin_requested: 'Re-opt-in requested' }
const PAGE_SIZE = 20
const day = (iso: string) => new Date(iso).toLocaleDateString()

export function OptOutsPage() {
  const auth = useAuth()
  const canRequest = auth.role === 'owner' || auth.role === 'admin'
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [reload, setReload] = useState(0)
  const [channel, setChannel] = useState<Channel | ''>('')
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<{ items: OptOutEntry[]; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { const t = setTimeout(() => { setDebounced(q.trim()); setPage(1) }, 250); return () => clearTimeout(t) }, [q])
  useEffect(() => {
    let alive = true
    api.optOuts({ channel: channel || undefined, q: debounced || undefined, page, pageSize: PAGE_SIZE })
      .then(r => { if (alive) { setData(r); setError(null) } }, e => { if (alive) setError(e.message) })
    return () => { alive = false }
  }, [channel, debounced, page, reload])

  const requestReoptIn = useCallback(async (o: OptOutEntry) => {
    const how = o.channel === 'email' ? 'an email with a link to resubscribe' : 'one text asking them to reply START'
    if (!window.confirm(`Send ${o.customerName ?? 'this customer'} ${how}? You can only ask once every 30 days, and they stay opted out unless they say yes.`)) return
    setBusy(o.id); setNotice(null)
    try {
      await api.requestReoptIn(o.id)
      setNotice({ kind: 'ok', text: `Re-opt-in request sent to ${o.customerName ?? o.contact}` })
      setReload(n => n + 1)
    } catch (e) { setNotice({ kind: 'err', text: e instanceof Error ? e.message : String(e) }) }
    finally { setBusy(null) }
  }, [])

  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1
  return (
    <PageShell title="Opt-out list" subtitle="Opt-outs are per channel: a text opt-out stops texts only, an email opt-out stops email only.">
      <div className="panel">
        <div className="filters">
          <label className="search"><Search size={15} aria-hidden />
            <input type="search" placeholder="Search name or contact" aria-label="Search opt-outs" value={q} onChange={e => setQ(e.target.value)} maxLength={100} />
          </label>
          <select aria-label="Channel" value={channel} onChange={e => { setChannel(e.target.value as Channel | ''); setPage(1) }}>
            <option value="">All channels</option><option value="sms">Text</option><option value="email">Email</option>
          </select>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        {notice && <p className={notice.kind === 'err' ? 'error' : 'green'} role={notice.kind === 'err' ? 'alert' : 'status'}>{notice.text}</p>}
        {!data ? <p className="muted">Loading…</p> : data.items.length === 0 ? <p className="muted">No opt-outs{debounced || channel ? ' match these filters' : ' yet'}.</p> : (
          <table className="table">
            <thead><tr><th>Customer</th><th>Contact</th><th>Channel</th><th>Opted out</th><th>Source</th><th>Re-opt-in</th></tr></thead>
            <tbody>
              {data.items.map(o => (
                <Fragment key={o.id}>
                <tr>
                  <td>
                    <button className="row-toggle" aria-expanded={open === o.id} aria-label={`History for ${o.customerName ?? o.contact}`}
                      onClick={() => setOpen(x => (x === o.id ? null : o.id))}>
                      {open === o.id ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
                      {o.customerName ?? <span className="muted">Unknown</span>}
                    </button>
                  </td>
                  <td className="mono">{o.contact}</td>
                  <td>{o.channel === 'sms' ? <><MessageCircle size={14} aria-hidden /> Text</> : <><Mail size={14} aria-hidden /> Email</>}</td>
                  <td>{new Date(o.createdAt).toLocaleDateString()}</td>
                  <td>{SOURCE_LABEL[o.source]}</td>
                  <td><ReoptCell o={o} canRequest={canRequest} busy={busy === o.id} onRequest={() => void requestReoptIn(o)} /></td>
                </tr>
                {open === o.id && <tr className="history-row"><td colSpan={6}><History id={o.id} key={`${o.id}-${reload}`} /></td></tr>}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
        {data && data.total > PAGE_SIZE && (
          <div className="pager">
            <button className="btn-small" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</button>
            <span className="muted small">Page {page} of {pages} · {data.total} total</span>
            <button className="btn-small" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Next</button>
          </div>
        )}
      </div>
    </PageShell>
  )
}

function ReoptCell({ o, canRequest, busy, onRequest }: { o: OptOutEntry; canRequest: boolean; busy: boolean; onRequest: () => void }) {
  const r = o.reoptIn
  if (r?.status === 'pending') return <span className="tag upcoming">Pending since {day(r.requestedAt)}</span>
  const cooling = r && Date.parse(r.nextAllowedAt) > Date.now()
  if (cooling) return <span className="muted small">Next request after {day(r!.nextAllowedAt)}</span>
  if (!canRequest) return <span className="muted small">{r ? `Last asked ${day(r.requestedAt)}` : '—'}</span>
  return (
    <button className="btn-small" disabled={busy || o.reason !== 'opt_out'} onClick={onRequest}
      title={o.reason !== 'opt_out' ? 'Bounced/complained contacts can’t be asked' : undefined}>
      <Send size={13} aria-hidden /> {busy ? 'Sending…' : 'Send re-opt-in request'}
    </button>
  )
}

/** Consent history for one contact (opt-outs, re-opt-ins, requests), newest first. */
function History({ id }: { id: string }) {
  const [events, setEvents] = useState<ConsentEvent[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { api.optOutHistory(id).then(setEvents, e => setError(e.message)) }, [id])
  if (error) return <p className="error" role="alert">{error}</p>
  if (!events) return <p className="muted small">Loading history…</p>
  if (!events.length) return <p className="muted small">No consent history recorded.</p>
  return (
    <ol className="consent-history" aria-label="Consent history">
      {events.map(e => (
        <li key={e.id}>
          <strong>{EVENT_LABEL[e.event]}</strong> · {e.channel === 'sms' ? 'Text' : 'Email'} · {CONSENT_SOURCE[e.source]}
          <span className="muted small"> · {new Date(e.createdAt).toLocaleString()}{e.actorId ? ' · by a team member' : e.requestId ? ` · ref ${e.requestId}` : ''}</span>
        </li>
      ))}
    </ol>
  )
}
