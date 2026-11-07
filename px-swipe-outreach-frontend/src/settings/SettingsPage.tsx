import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { api } from '../api'
import { useAuth } from '../auth/AuthProvider'
import { PageShell } from '../components/PageShell'
import { SettingsTabs } from './SettingsTabs'
import { emptyDeal, PromotionForm } from '../deals/PromotionForm'
import { toInput, useDeals } from '../deals/useDeals'
import { charCount } from '../lib/format'
import { categoryLabel, DAYS_SHORT, discountLabel, formatRange, rangeStatus } from '../lib/week'
import type { BrandVoice, DealInput, OrgSettings } from '../types'

export const SMS_SIGNATURE_MAX = 60
export const DEFAULT_VOICE: BrandVoice = { preset: 'friendly', emoji: false, signOff: '', about: '' }
const PRESETS: Record<BrandVoice['preset'], string> = {
  friendly: 'Friendly local shop: warm, neighborly, plain words',
  chill: 'Chill: relaxed, short and casual',
  premium: 'Premium lounge: polished, no slang'
}

export function SettingsPage() {
  const auth = useAuth()
  const canEdit = auth.role === 'owner' || auth.role === 'admin'
  return (
    <PageShell title="Settings" subtitle={canEdit ? 'Saved for your whole store' : 'Only owners and admins can change settings'}>
      <SettingsTabs current="general" />
      <StoreSettings canEdit={canEdit} />
      <Promotions canEdit={canEdit} />
    </PageShell>
  )
}

function StoreSettings({ canEdit }: { canEdit: boolean }) {
  const [s, setS] = useState<OrgSettings | null>(null)
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => { api.settings.get().then(setS, e => setStatus({ kind: 'err', text: e.message })) }, [])
  if (!s) return <section className="panel">{status ? <p className="error" role="alert">{status.text}</p> : <p className="muted">Loading…</p>}</section>
  const set = <K extends keyof OrgSettings>(k: K, v: OrgSettings[K]) => setS({ ...s, [k]: v })
  const voice = s.brandVoice ?? DEFAULT_VOICE
  const setVoice = (v: Partial<BrandVoice>) => set('brandVoice', { ...voice, ...v })

  async function save(e: FormEvent) {
    e.preventDefault()
    setSaving(true); setStatus(null)
    try {
      setS(await api.settings.save({ ...s!, storeName: s!.storeName?.trim() || null }))
      setStatus({ kind: 'ok', text: 'Settings saved' })
    } catch (err) { setStatus({ kind: 'err', text: err instanceof Error ? err.message : String(err) }) }
    finally { setSaving(false) }
  }

  return (
    <form className="panel settings-form" onSubmit={save} aria-label="Store settings">
      <h3 className="eyebrow">Store</h3>
      <fieldset disabled={!canEdit}>
        <label>Store name<input maxLength={100} value={s.storeName ?? ''} onChange={e => set('storeName', e.target.value)} placeholder="Used in messages" /></label>
        <div className="row-fields">
          <label>Default channel
            <select value={s.defaultChannel ?? ''} onChange={e => set('defaultChannel', (e.target.value || null) as OrgSettings['defaultChannel'])}>
              <option value="">Customer's preference</option><option value="sms">Text</option><option value="email">Email</option>
            </select>
          </label>
          <label>Max discount (%)
            <input type="number" min={0} max={100} value={s.maxDiscountPercent} onChange={e => set('maxDiscountPercent', Number(e.target.value))} />
          </label>
        </div>
        <label>Email signature
          <textarea rows={4} maxLength={1000} value={s.emailSignature} onChange={e => set('emailSignature', e.target.value)} placeholder={'Cloud 9 Smoke Shop\n123 Main St'} />
        </label>
        <label>Text signature
          <input maxLength={SMS_SIGNATURE_MAX} value={s.smsSignature} onChange={e => set('smsSignature', e.target.value.replace(/[\r\n]/g, ''))} placeholder="-Cloud 9" />
        </label>
        <p className="muted small">{charCount(s.smsSignature)}/{SMS_SIGNATURE_MAX} · added to every text and counted in its length. Texts also end with “Reply STOP to opt out.”</p>
      </fieldset>
      <h3 className="eyebrow">Brand voice</h3>
      <p className="muted small">How AI suggestions sound. Compliance rules (no health claims, nothing aimed at minors, no invented deals, discounts within your cap) always apply.</p>
      <fieldset disabled={!canEdit} aria-label="Brand voice">
        <div className="row-fields">
          <label>Voice
            <select value={voice.preset} onChange={e => setVoice({ preset: e.target.value as BrandVoice['preset'] })}>
              {(Object.keys(PRESETS) as BrandVoice['preset'][]).map(p => <option key={p} value={p}>{PRESETS[p]}</option>)}
            </select>
          </label>
          <label className="check"><input type="checkbox" checked={voice.emoji} onChange={e => setVoice({ emoji: e.target.checked })} /> Allow emoji</label>
        </div>
        <label>Email sign-off<input maxLength={40} value={voice.signOff} onChange={e => setVoice({ signOff: e.target.value.replace(/[\r\n]/g, '') })} placeholder="See you soon!" /></label>
        <label>About our shop
          <textarea rows={3} maxLength={500} value={voice.about} onChange={e => setVoice({ about: e.target.value })} placeholder="Family-owned on Main St since 2014. Big humidor, local glass artists." />
        </label>
        <p className="muted small">{charCount(voice.about)}/500 · the AI may use these facts for color; it never invents beyond them.</p>
      </fieldset>
      {status && <p className={status.kind === 'err' ? 'error' : 'green'} role={status.kind === 'err' ? 'alert' : 'status'}>{status.text}</p>}
      {canEdit && <div className="form-actions"><button className="btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button></div>}
    </form>
  )
}

/** Reusable promotions. The checkbox enables/disables one; the weekly panel and the AI only use enabled ones. */
function Promotions({ canEdit }: { canEdit: boolean }) {
  const { deals, catalog, error, create, update, remove } = useDeals()
  const [editing, setEditing] = useState<{ id: string | null; input: DealInput } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const sectionRef = useRef<HTMLElement>(null)
  // /settings#promotions (e.g. "Manage promotions" in the deals panel) jumps here once the list has loaded.
  useEffect(() => {
    if (deals && window.location.hash === '#promotions') {
      sectionRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
      sectionRef.current?.focus({ preventScroll: true })
    }
  }, [deals])
  const act = (fn: () => Promise<void>) => fn().catch(e => setErr(e instanceof Error ? e.message : String(e)))

  return (
    <section className="panel" id="promotions" aria-labelledby="promos-h" ref={sectionRef} tabIndex={-1}>
      <div className="panel-head">
        <h3 id="promos-h" className="eyebrow">Promotions</h3>
        {canEdit && !editing && <button className="btn-small" onClick={() => setEditing({ id: null, input: emptyDeal([]) })}><Plus size={14} /> Add promotion</button>}
      </div>
      <p className="muted small">Enabled promotions appear in the weekly deals panel on their days and are used by the AI suggestions.</p>
      {(error || err) && <p className="error" role="alert">{error ?? err}</p>}
      {editing && (
        <PromotionForm initial={editing.input} catalog={catalog} onCancel={() => setEditing(null)}
          onSave={async d => { if (editing.id) await update(editing.id, d); else await create(d); setEditing(null) }} />
      )}
      {!deals ? <p className="muted">Loading…</p> : (
        <ul className="rows">
          {deals.map(d => (
            <li key={d.id} className={`row ${d.active ? '' : 'disabled'}`}>
              <label className="row-main check">
                <input type="checkbox" checked={d.active} disabled={!canEdit} aria-label={`Enable ${d.title}`}
                  onChange={e => void act(() => update(d.id, { ...toInput(d), active: e.target.checked }))} />
                <div>
                  <div className="row-title">{d.title} <span className="tag">{discountLabel(d)}</span></div>
                  <div className="muted small">
                    {d.schedule === 'range'
                      ? `Seasonal · every day ${formatRange(d.startsOn, d.endsOn)} · ${rangeStatus(d.startsOn, d.endsOn).label}`
                      : d.days.length === 7 ? 'Every day' : d.days.map(i => DAYS_SHORT[i]).join(', ')}
                    {d.categories.length > 0 && ` · ${d.categories.map(categoryLabel).join(', ')}`}
                    {d.schedule !== 'range' && (d.startsOn || d.endsOn) && ` · ${d.startsOn ?? '…'} → ${d.endsOn ?? '…'}`}
                  </div>
                </div>
              </label>
              {canEdit && (
                <div className="row-actions">
                  <button className="icon-btn" aria-label={`Edit ${d.title}`} onClick={() => setEditing({ id: d.id, input: toInput(d) })}><Pencil size={15} /></button>
                  <button className="icon-btn danger" aria-label={`Delete ${d.title}`}
                    onClick={() => { if (window.confirm(`Delete "${d.title}"?`)) void act(() => remove(d.id)) }}><Trash2 size={15} /></button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
