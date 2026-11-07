import { useState } from 'react'
import { CalendarDays, CalendarRange, Pencil, Plus, Settings2, Tag, Trash2, X } from 'lucide-react'
import { navigate } from '../router'
import { useOptionalAuth } from '../auth/AuthProvider'
import type { Deal, DealInput } from '../types'
import { categoryLabel, DAYS, discountLabel, formatRange, rangeStatus, todayIndex } from '../lib/week'
import { emptyDeal, PromotionForm } from './PromotionForm'
import { toInput, useDeals } from './useDeals'

/**
 * Weekly slots (Mon–Sun) of deals, specials and promotions. Each slot shows the enabled promotions that run
 * that day; the suggestion engine uses exactly these. Promotions are reusable: one can run on several days.
 */
export function DealsPanel({ onChange }: { onChange?: () => void }) {
  const auth = useOptionalAuth()
  const canEdit = auth?.role === 'owner' || auth?.role === 'admin'
  const { deals, catalog, error, create, update, remove } = useDeals(onChange)
  const [editing, setEditing] = useState<{ id: string | null; input: DealInput } | null>(null)
  const today = todayIndex()

  async function removeSeasonal(deal: Deal) {
    if (!window.confirm(`Delete "${deal.title}"? To pause it instead, untick it in Settings → Promotions.`)) return
    await remove(deal.id)
  }

  async function removeFromDay(deal: Deal, day: number) {
    if (deal.days.length > 1) {
      if (!window.confirm(`Remove "${deal.title}" from ${DAYS[day]}? It stays on its other days.`)) return
      await update(deal.id, { ...toInput(deal), days: deal.days.filter(d => d !== day) })
    } else {
      if (!window.confirm(`Delete "${deal.title}"? To pause it instead, untick it in Settings → Promotions.`)) return
      await remove(deal.id)
    }
  }

  return (
    <aside className="deals-panel" aria-label="Deals this week">
      <h2 className="panel-title"><CalendarDays size={18} aria-hidden /> Deals this week</h2>
      <p className="muted small">The AI picks the best enabled deal for each customer.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {!deals && !error && <p className="muted small">Loading…</p>}
      {editing && (
        <div className="panel-form">
          <PromotionForm initial={editing.input} catalog={catalog} onCancel={() => setEditing(null)}
            onSave={async d => { if (editing.id) await update(editing.id, d); else await create(d); setEditing(null) }} />
        </div>
      )}
      {deals && (
        <ol className="week">
          {DAYS.map((day, i) => {
            const items = deals.filter(d => d.schedule !== 'range' && d.active && d.days.includes(i))
            return (
              <li key={day} className={`day ${i === today ? 'today' : ''}`} aria-label={day}>
                <div className="day-head">
                  <strong>{day}{i === today && <span className="tag">Today</span>}</strong>
                  {canEdit && (
                    <button className="icon-btn sm" aria-label={`Add deal on ${day}`} title="Add" onClick={() => setEditing({ id: null, input: emptyDeal([i]) })}>
                      <Plus size={15} />
                    </button>
                  )}
                </div>
                {items.length === 0 && <p className="muted small">No deals</p>}
                {items.map(d => (
                  <div key={d.id} className="deal">
                    <Tag size={14} aria-hidden className="green" />
                    <div className="deal-body">
                      <span className="deal-title">{d.title}</span>
                      <span className="deal-meta">{discountLabel(d)}{d.categories.length ? ` · ${d.categories.map(categoryLabel).join(', ')}` : ''}</span>
                    </div>
                    {canEdit && (
                      <span className="deal-actions">
                        <button className="icon-btn sm" aria-label={`Edit ${d.title}`} onClick={() => setEditing({ id: d.id, input: toInput(d) })}><Pencil size={13} /></button>
                        <button className="icon-btn sm danger" aria-label={`Remove ${d.title} from ${day}`} onClick={() => void removeFromDay(d, i)}><X size={13} /></button>
                      </span>
                    )}
                  </div>
                ))}
              </li>
            )
          })}
        </ol>
      )}
      {deals && <SeasonalDeals deals={deals.filter(d => d.schedule === 'range')} canEdit={canEdit}
        onAdd={() => setEditing({ id: null, input: emptyDeal([], 'range') })}
        onEdit={d => setEditing({ id: d.id, input: toInput(d) })} onRemove={d => void removeSeasonal(d)} />}
      <button className="btn-small manage-promos" onClick={() => navigate('/settings#promotions')}>
        <Settings2 size={14} aria-hidden /> Manage promotions
      </button>
    </aside>
  )
}

/**
 * Longer-running promotions (holiday season, Black Friday weekend, 4/20 week, month-long specials) that apply every
 * day in a date range. Ended ones are hidden here (they stay in Settings → Promotions).
 */
function SeasonalDeals({ deals, canEdit, onAdd, onEdit, onRemove }: {
  deals: Deal[]; canEdit: boolean; onAdd: () => void; onEdit: (d: Deal) => void; onRemove: (d: Deal) => void
}) {
  const items = deals
    .map(d => ({ d, status: rangeStatus(d.startsOn, d.endsOn) }))
    .filter(x => x.status.state !== 'ended')
    .sort((a, b) => (a.d.startsOn ?? '').localeCompare(b.d.startsOn ?? ''))
  return (
    <section className="seasonal" aria-labelledby="seasonal-h">
      <div className="day-head">
        <h3 id="seasonal-h" className="panel-subtitle"><CalendarRange size={16} aria-hidden /> Seasonal &amp; ongoing deals</h3>
        {canEdit && (
          <button className="icon-btn sm" aria-label="Add seasonal deal" title="Add" onClick={onAdd}><Plus size={15} /></button>
        )}
      </div>
      {items.length === 0 && <p className="muted small">No seasonal deals. Add one for a holiday or a month-long special.</p>}
      <ul className="seasonal-list">
        {items.map(({ d, status }) => (
          <li key={d.id} className={`deal seasonal-item ${d.active ? '' : 'off'}`} aria-label={d.title}>
            <Tag size={14} aria-hidden className={d.active ? 'green' : 'muted'} />
            <div className="deal-body">
              <span className="deal-title">{d.title}</span>
              <span className="deal-meta">{formatRange(d.startsOn, d.endsOn)} · {discountLabel(d)}</span>
              <span className="deal-badges">
                <span className={`tag ${status.state}`}>{status.label}</span>
                <span className={`tag ${d.active ? 'enabled' : 'disabled'}`}>{d.active ? 'Enabled' : 'Disabled'}</span>
              </span>
            </div>
            {canEdit && (
              <span className="deal-actions">
                <button className="icon-btn sm" aria-label={`Edit ${d.title}`} onClick={() => onEdit(d)}><Pencil size={13} /></button>
                <button className="icon-btn sm danger" aria-label={`Delete ${d.title}`} onClick={() => onRemove(d)}><Trash2 size={13} /></button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
