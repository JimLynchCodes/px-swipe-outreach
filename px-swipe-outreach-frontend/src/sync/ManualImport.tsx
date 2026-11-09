import { useRef, useState } from 'react'
import { Upload } from 'lucide-react'
import { api, type CsvUploadProgress } from '../api'
import { Modal } from '../components/Modal'
import { money } from '../lib/format'
import type { ImportPreview } from '../types'
import { ErrorBubble } from '../components/ErrorBubble'
import { friendlyError } from '../lib/errors'
import { ImportProgress, type ImportProgressState } from './ImportProgress'

const MAX_BYTES = 5 * 1024 * 1024
type Step =
  | { kind: 'idle' }
  | { kind: 'reading' }
  | { kind: 'preview'; csv: string; fileName: string; preview: ImportPreview }
  | { kind: 'saving'; csv: string; fileName: string; preview: ImportPreview }
  | { kind: 'done'; inserted: number; existing: number }

function toBar(p: CsvUploadProgress, rowTotal?: number): ImportProgressState {
  if (p.phase === 'uploading') {
    return { phase: 'uploading', percent: p.ratio == null ? null : Math.round(p.ratio * 100) }
  }
  if (p.phase === 'writing') {
    const done = p.done ?? (p.ratio != null && rowTotal != null ? Math.round(p.ratio * rowTotal) : undefined)
    const total = p.total ?? rowTotal
    const percent = p.ratio != null ? Math.round(p.ratio * 100) : (total && done != null ? Math.round((done / total) * 100) : null)
    return { phase: 'writing', percent, done, total }
  }
  return { phase: 'parsing', percent: null }
}

/** "Manually add" on the Data sync page: pick a customer CSV, review only the NEW customers, Submit or Cancel. */
export function ManualImport() {
  const input = useRef<HTMLInputElement>(null)
  const [step, setStep] = useState<Step>({ kind: 'idle' })
  const [err, setErr] = useState<string | null>(null)
  const [progress, setProgress] = useState<ImportProgressState | null>(null)

  async function onFile(file: File | undefined) {
    if (input.current) input.current.value = '' // same file can be picked again
    if (!file) return
    setErr(null)
    if (!/\.csv$/i.test(file.name) && file.type !== 'text/csv') { setErr('Please choose a .csv file.'); return }
    if (file.size > MAX_BYTES) { setErr('That file is over 5 MB. Split it into smaller files.'); return }
    setStep({ kind: 'reading' })
    setProgress({ phase: 'reading', percent: null })
    try {
      const csv = await file.text()
      setProgress({ phase: 'uploading', percent: 0 })
      const preview = await api.customers.preview(csv, p => setProgress(toBar(p)))
      setProgress(null)
      setStep({ kind: 'preview', csv, fileName: file.name, preview })
    } catch (e) { setErr(friendlyError(e)); setProgress(null); setStep({ kind: 'idle' }) }
  }

  async function submit() {
    if (step.kind !== 'preview') return
    const snap = step
    setStep({ ...snap, kind: 'saving' }); setErr(null)
    setProgress({ phase: 'uploading', percent: 0 })
    try {
      const rowTotal = snap.preview.newCustomers.length || snap.preview.totalRows
      const r = await api.customers.import(snap.csv, p => setProgress(toBar(p, rowTotal)))
      setProgress(null)
      setStep({ kind: 'done', inserted: r.inserted, existing: r.existing })
    } catch (e) { setErr(friendlyError(e)); setProgress(null); setStep({ ...snap, kind: 'preview' }) }
  }

  const cancel = () => { setStep({ kind: 'idle' }); setErr(null); setProgress(null) }
  const p = step.kind === 'preview' || step.kind === 'saving' ? step.preview : null
  const busy = step.kind === 'reading' || step.kind === 'saving'
  const skipped = p ? [
    p.existing && `${p.existing} already in your customers`,
    p.duplicatesInFile && `${p.duplicatesInFile} repeated in the file`,
    p.invalid.length && `${p.invalid.length} invalid`,
  ].filter(Boolean).join(' · ') : ''

  return (
    <section className="panel" aria-label="Manually add customers">
      <div className="row-between">
        <div>
          <h3><Upload size={17} aria-hidden /> Customers from a file</h3>
          <p className="muted small">Upload a customer CSV (e.g. Quickvee's customer export). Only customers who aren't already here (by customer ID, phone or email) are added.</p>
        </div>
        <div className="btn-wrap">
          <button className="btn-secondary" aria-label="Manually add customers" onClick={() => input.current?.click()} disabled={busy}>
            {step.kind === 'reading' ? 'Reading…' : 'Manually add'}
          </button>
          <ErrorBubble error={step.kind === 'idle' || step.kind === 'reading' ? err : null} />
        </div>
        <input ref={input} type="file" accept=".csv,text/csv" hidden aria-label="Customer CSV file" onChange={e => void onFile(e.target.files?.[0])} />
      </div>

      {progress && step.kind === 'reading' && <ImportProgress progress={progress} />}

      {p && (step.kind === 'preview' || step.kind === 'saving') && (
        <Modal title={p.newCustomers.length ? `Add ${p.newCustomers.length} new customer${p.newCustomers.length === 1 ? '' : 's'}?` : 'No new customers'}
          onClose={step.kind === 'preview' ? cancel : undefined}
          actions={<>
            <button className="btn-secondary" onClick={cancel} disabled={step.kind === 'saving'}>Cancel</button>
            {p.newCustomers.length > 0 && <button className="btn-primary" onClick={() => void submit()} disabled={step.kind === 'saving'}>{step.kind === 'saving' ? 'Saving…' : 'Submit'}</button>}
            <ErrorBubble error={err} className="modal-error" />
          </>}>
          <p className="muted small">{step.fileName}{skipped && ` · skipped: ${skipped}`}</p>
          {progress && step.kind === 'saving' && <ImportProgress progress={progress} />}
          {p.newCustomers.length > 0 ? (
            <ul className="rows import-list" aria-label="New customers">
              {p.newCustomers.map(c => (
                <li key={c.row} className="row">
                  <div className="row-main"><div>
                    <div className="row-title">{c.name}</div>
                    <div className="muted small">{[c.phone, c.email, c.location, c.lifetimeSpendCents ? `${money(c.lifetimeSpendCents)} lifetime` : null].filter(Boolean).join(' · ')}</div>
                  </div></div>
                </li>
              ))}
            </ul>
          ) : <p>Everyone in this file is already in your customer list (or the rows were invalid).</p>}
          {p.invalid.length > 0 && (
            <details className="small"><summary>{p.invalid.length} invalid row{p.invalid.length === 1 ? '' : 's'} won't be added</summary>
              <ul>{p.invalid.slice(0, 50).map(r => <li key={r.row}>Row {r.row}: {r.reason}</li>)}</ul>
            </details>
          )}
          {p.newCustomers.length > 0 && <p className="muted small">They'll be added as opted in to texts and email and verified 21+ (checked at in-store signup). The consent history records this as an in-store signup via import.</p>}
        </Modal>
      )}

      {step.kind === 'done' && (
        <Modal title="Customers added" onClose={cancel} actions={<button className="btn-primary" onClick={cancel}>OK</button>}>
          <p>Added {step.inserted} new customer{step.inserted === 1 ? '' : 's'}.{step.existing > 0 && ` ${step.existing} already existed and were skipped.`} They're now in Registered users and the outreach deck.</p>
        </Modal>
      )}
    </section>
  )
}
