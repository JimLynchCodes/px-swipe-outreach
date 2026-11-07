import { useState } from 'react'
import { CalendarDays, Pencil, Plus, Tag, X } from 'lucide-react'
import { useOptionalAuth } from '../auth/AuthProvider'
import type { Deal, DealInput } from '../types'
import { categoryLabel, DAYS, discountLabel, todayIndex } from '../lib/week'
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
            const items = deals.filter(d => d.active && d.days.includes(i))
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
    </aside>
  )
}
