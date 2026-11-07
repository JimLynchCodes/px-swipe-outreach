import { useEffect, useState } from 'react'
import { Mail, MessageCircle, Search } from 'lucide-react'
import { api } from '../api'
import { PageShell } from '../components/PageShell'
import type { Channel, OptOutEntry, OptOutSource } from '../types'

const SOURCE_LABEL: Record<OptOutSource, string> = { sms_stop: 'STOP reply', email_unsubscribe: 'Unsubscribe link', manual: 'Manual', provider: 'Bounce/complaint' }
const PAGE_SIZE = 20

export function OptOutsPage() {
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
  }, [channel, debounced, page])

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
        {!data ? <p className="muted">Loading…</p> : data.items.length === 0 ? <p className="muted">No opt-outs{debounced || channel ? ' match these filters' : ' yet'}.</p> : (
          <table className="table">
            <thead><tr><th>Customer</th><th>Contact</th><th>Channel</th><th>Opted out</th><th>Source</th></tr></thead>
            <tbody>
              {data.items.map(o => (
                <tr key={o.id}>
                  <td>{o.customerName ?? <span className="muted">Unknown</span>}</td>
                  <td className="mono">{o.contact}</td>
                  <td>{o.channel === 'sms' ? <><MessageCircle size={14} aria-hidden /> Text</> : <><Mail size={14} aria-hidden /> Email</>}</td>
                  <td>{new Date(o.createdAt).toLocaleDateString()}</td>
                  <td>{SOURCE_LABEL[o.source]}</td>
                </tr>
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
