import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Sparkles } from 'lucide-react'
import { api } from '../api'
import { useOptionalAuth } from '../auth/AuthProvider'
import type { AiModelOption } from '../types'

export const AI_MODEL_CHANGED = 'ai-model:changed'

/**
 * "Using model <name> ▾" pill. Owners/admins pick the org's suggestion model (saved in Settings);
 * staff see the list read-only. Models whose provider has no API key are shown unavailable (rules are used).
 */
export function ModelPicker() {
  const auth = useOptionalAuth()
  const canEdit = auth?.role === 'owner' || auth?.role === 'admin'
  const [data, setData] = useState<{ models: AiModelOption[]; selected: string; effective: string } | null>(null)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => { api.aiModels().then(setData, () => setData(null)) }, [auth?.orgId])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onClick = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onClick)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onClick) }
  }, [open])

  if (!data) return <span className="pill"><Sparkles size={14} aria-hidden /> AI suggestions</span>
  const selected = data.models.find(m => m.id === data.selected)
  const fallback = data.effective !== data.selected
  const label = selected ? selected.label : data.selected

  async function pick(id: string) {
    if (!canEdit || id === data!.selected) { setOpen(false); return }
    setSaving(true); setError(null)
    try {
      const current = await api.settings.get()
      await api.settings.save({ ...current, aiModel: id })
      setData(await api.aiModels())
      setOpen(false)
      window.dispatchEvent(new Event(AI_MODEL_CHANGED))
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setSaving(false) }
  }

  return (
    <div className="model-picker" ref={ref}>
      <button className="pill model-pill" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}
        title={fallback ? 'Selected model is unavailable; using rules' : undefined}>
        <Sparkles size={14} aria-hidden /> Using model {label}{fallback && ' (rules fallback)'} <ChevronDown size={14} aria-hidden />
      </button>
      {open && (
        <div className="menu model-menu" role="menu" aria-label="AI model">
          {!canEdit && <p className="muted small model-note">Only owners and admins can change the model.</p>}
          {data.models.map(m => (
            <button key={m.id} role="menuitemradio" aria-checked={m.id === data.selected} className="model-item"
              disabled={!canEdit || saving || (!m.available && m.id !== data.selected)} onClick={() => void pick(m.id)}>
              <span className="model-check">{m.id === data.selected && <Check size={14} aria-hidden />}</span>
              <span className="model-text">
                <span>{m.label}{!m.available && <span className="tag disabled">Unavailable</span>}</span>
                <span className="muted small">{m.costHint}{m.provider !== 'rules' && ` · $${m.inputPerM}/$${m.outputPerM} per 1M tokens`}</span>
              </span>
            </button>
          ))}
          {data.models.some(m => !m.available) && (
            <p className="muted small model-note">{data.models.find(m => !m.available)?.note}</p>
          )}
          {error && <p className="error small" role="alert">{error}</p>}
        </div>
      )}
    </div>
  )
}
