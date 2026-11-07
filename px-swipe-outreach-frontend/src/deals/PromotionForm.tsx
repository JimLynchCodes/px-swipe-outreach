import { useState, type FormEvent } from 'react'
import type { CatalogProduct, DealInput, DiscountType } from '../types'
import { categoryLabel, DAYS_SHORT } from '../lib/week'

export const emptyDeal = (days: number[] = []): DealInput => ({
  days, title: '', description: '', discountType: 'percent', discountValue: 10, categories: [], productIds: [],
  startsOn: null, endsOn: null, active: true,
})

interface Props {
  initial: DealInput
  catalog: { products: CatalogProduct[]; categories: string[] }
  onSave: (d: DealInput) => Promise<void>
  onCancel: () => void
}

/** Add/edit a promotion. Amounts are entered in dollars and stored in cents. */
export function PromotionForm({ initial, catalog, onSave, onCancel }: Props) {
  const [d, setD] = useState<DealInput>(initial)
  const [value, setValue] = useState(() => initial.discountValue == null ? ''
    : initial.discountType === 'amount' ? String(initial.discountValue / 100) : String(initial.discountValue))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const set = <K extends keyof DealInput>(k: K, v: DealInput[K]) => setD(x => ({ ...x, [k]: v }))
  const toggle = <T,>(xs: T[], x: T) => (xs.includes(x) ? xs.filter(y => y !== x) : [...xs, x])
  const needsValue = d.discountType === 'percent' || d.discountType === 'amount'

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!d.days.length) { setError('Pick at least one day'); return }
    const n = Number(value)
    if (needsValue && !(n > 0)) { setError('Enter a discount'); return }
    setSaving(true); setError(null)
    try {
      await onSave({
        ...d, title: d.title.trim(), description: d.description.trim(),
        discountValue: !needsValue ? null : d.discountType === 'amount' ? Math.round(n * 100) : Math.round(n),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  return (
    <form className="promo-form" onSubmit={submit} aria-label="Promotion">
      <label>Title<input required maxLength={80} value={d.title} onChange={e => set('title', e.target.value)} placeholder="Cigar Friday" /></label>
      <label>Description<textarea maxLength={300} rows={2} value={d.description} onChange={e => set('description', e.target.value)}
        placeholder="20% off premium singles" /></label>
      <div className="row-fields">
        <label>Discount
          <select value={d.discountType} onChange={e => set('discountType', e.target.value as DiscountType)}>
            <option value="percent">% off</option><option value="amount">$ off</option>
            <option value="bogo">Buy one, get one</option><option value="freebie">Free gift</option>
          </select>
        </label>
        {needsValue && (
          <label>{d.discountType === 'percent' ? 'Percent' : 'Dollars'}
            <input type="number" min={d.discountType === 'percent' ? 1 : 0.01} max={d.discountType === 'percent' ? 100 : 1000}
              step={d.discountType === 'percent' ? 1 : 0.01} value={value} onChange={e => setValue(e.target.value)} aria-label="Discount value" />
          </label>
        )}
      </div>
      <fieldset><legend>Days</legend>
        <div className="chips">
          {DAYS_SHORT.map((label, i) => (
            <label key={label} className={`chip ${d.days.includes(i) ? 'on' : ''}`}>
              <input type="checkbox" checked={d.days.includes(i)} onChange={() => set('days', toggle(d.days, i).sort())} />{label}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset><legend>Categories</legend>
        <div className="chips">
          {catalog.categories.map(c => (
            <label key={c} className={`chip ${d.categories.includes(c) ? 'on' : ''}`}>
              <input type="checkbox" checked={d.categories.includes(c)} onChange={() => set('categories', toggle(d.categories, c))} />{categoryLabel(c)}
            </label>
          ))}
        </div>
      </fieldset>
      <label>Products (optional)
        <select multiple size={4} value={d.productIds} aria-label="Products"
          onChange={e => set('productIds', [...e.target.selectedOptions].map(o => o.value))}>
          {catalog.products.map(p => <option key={p.id} value={p.id}>{p.name}{p.brand ? ` · ${p.brand}` : ''}</option>)}
        </select>
      </label>
      <div className="row-fields">
        <label>Starts<input type="date" value={d.startsOn ?? ''} onChange={e => set('startsOn', e.target.value || null)} /></label>
        <label>Ends<input type="date" value={d.endsOn ?? ''} onChange={e => set('endsOn', e.target.value || null)} /></label>
      </div>
      <label className="check"><input type="checkbox" checked={d.active} onChange={e => set('active', e.target.checked)} /> Enabled</label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="form-actions">
        <button type="button" className="btn-small" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  )
}
