import { useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { api } from '../api'
import { PageShell } from '../components/PageShell'
import { money, sinceShort } from '../lib/format'
import { navigate, ROUTES } from '../router'
import type { CustomerSummary } from '../types'
import { ErrorBubble } from '../components/ErrorBubble'
import { friendlyError } from '../lib/errors'

/** Customers in this store (newest first). Clicking one opens a fresh suggestion card for them on the deck. */
export function RegisteredUsersPage() {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<{ items: CustomerSummary[]; total: number; pageSize: number } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [openErr, setOpenErr] = useState<{ id: string; text: string } | null>(null)

  useEffect(() => {
    let live = true
    const t = setTimeout(() => {
      api.customers.list(search.trim(), page).then(d => { if (live) { setData(d); setErr(null) } }, e => live && setErr(friendlyError(e)))
    }, 200)
    return () => { live = false; clearTimeout(t) }
  }, [search, page])

  async function open(c: CustomerSummary) {
    setOpening(c.id); setOpenErr(null)
    try {
      const opp = await api.customers.open(c.id)
      navigate(`${ROUTES.home}?customer=${encodeURIComponent(opp)}`)
    } catch (e) { setOpenErr({ id: c.id, text: friendlyError(e) }); setOpening(null) }
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1
  return (
    <PageShell title="Registered users" subtitle={data ? `${data.total} customer${data.total === 1 ? '' : 's'}` : 'Your customers'}>
      <section className="panel">
        <input type="search" aria-label="Search customers" placeholder="Search name, phone or email" value={search}
          onChange={e => { setSearch(e.target.value); setPage(1) }} />
        <ErrorBubble error={err} />
        {!data ? <p className="muted">Loading…</p> : data.items.length === 0 ? <p className="muted">No customers found.</p> : (
          <ul className="rows" aria-label="Customers">
            {data.items.map(c => (
              <li key={c.id} className="row">
                <button className="customer-row row-main" onClick={() => void open(c)} disabled={opening !== null} aria-label={`Open ${c.name}`}>
                  <div>
                    <div className="row-title">{c.name} {c.source === 'csv' && <span className="tag">Imported</span>}</div>
                    <div className="muted small">
                      {[c.phone, c.email, c.location, c.lifetimeSpendCents ? `${money(c.lifetimeSpendCents)} lifetime` : null].filter(Boolean).join(' · ')}
                    </div>
                    <div className="muted small">Last text {sinceShort(c.lastSmsAt)} · Last email {sinceShort(c.lastEmailAt)}</div>
                  </div>
                </button>
                <ChevronRight size={18} className="muted" aria-hidden />
                {openErr?.id === c.id && <ErrorBubble error={openErr.text} className="row-error" />}
              </li>
            ))}
          </ul>
        )}
        {pages > 1 && (
          <div className="row-between">
            <button className="btn-small" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</button>
            <span className="muted small">Page {page} of {pages}</span>
            <button className="btn-small" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Next</button>
          </div>
        )}
      </section>
    </PageShell>
  )
}
