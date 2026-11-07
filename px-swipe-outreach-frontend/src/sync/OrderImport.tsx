import { useRef, useState } from 'react'
import { ReceiptText } from 'lucide-react'
import { api } from '../api'
import { Modal } from '../components/Modal'
import { money } from '../lib/format'
import type { OrderImportPreview, OrderLink } from '../types'

const MAX_BYTES = 5 * 1024 * 1024
const LINK: Record<OrderLink, string> = { existing: 'Customer on file', new: 'New customer', unlinked: 'No customer (skipped)' }
type Step =
  | { kind: 'idle' } | { kind: 'reading' }
  | { kind: 'preview' | 'saving'; csv: string; fileName: string; preview: OrderImportPreview }
  | { kind: 'done'; inserted: number; existing: number; customersCreated: number; unlinked: number }

/** Data sync → Manually add (order history): preview new orders (deduped by order ID), Submit or Cancel, then a success modal. */
export function OrderImport() {
  const input = useRef<HTMLInputElement>(null)
  const [step, setStep] = useState<Step>({ kind: 'idle' })
  const [err, setErr] = useState<string | null>(null)

  async function onFile(file: File | undefined) {
    if (input.current) input.current.value = ''
    if (!file) return
    setErr(null)
    if (!/\.csv$/i.test(file.name) && file.type !== 'text/csv') { setErr('Please choose a .csv file.'); return }
    if (file.size > MAX_BYTES) { setErr('That file is over 5 MB. Export a shorter date range.'); return }
    setStep({ kind: 'reading' })
    try {
      const csv = await file.text()
      setStep({ kind: 'preview', csv, fileName: file.name, preview: await api.orders.preview(csv) })
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setStep({ kind: 'idle' }) }
  }
  async function submit() {
    if (step.kind !== 'preview') return
    setStep({ ...step, kind: 'saving' }); setErr(null)
    try {
      const r = await api.orders.import(step.csv)
      setStep({ kind: 'done', ...r })
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setStep({ ...step, kind: 'preview' }) }
  }
  const cancel = () => { setStep({ kind: 'idle' }); setErr(null) }
  const p = step.kind === 'preview' || step.kind === 'saving' ? step.preview : null
  const importable = p ? p.newOrderCount - p.links.unlinked : 0

  return (
    <section className="panel" aria-label="Manually add order history">
      <div className="row-between">
        <div>
          <h3><ReceiptText size={17} aria-hidden /> Order history from a file</h3>
          <p className="muted small">Upload an order-history CSV (one row per item; <code>npm run scrape:quickvee:orders</code> writes this format). Orders already loaded (same order ID) are skipped. Orders feed purchase history and suggestions.</p>
        </div>
        <button className="btn-secondary" aria-label="Manually add orders" onClick={() => input.current?.click()} disabled={step.kind === 'reading'}>
          {step.kind === 'reading' ? 'Reading…' : 'Manually add'}
        </button>
        <input ref={input} type="file" accept=".csv,text/csv" hidden aria-label="Order history CSV file" onChange={e => void onFile(e.target.files?.[0])} />
      </div>
      {err && step.kind === 'idle' && <p className="error" role="alert">{err}</p>}

      {p && (step.kind === 'preview' || step.kind === 'saving') && (
        <Modal title={importable ? `Add ${importable} new order${importable === 1 ? '' : 's'}?` : 'No new orders'}
          onClose={step.kind === 'preview' ? cancel : undefined}
          actions={<>
            <button className="btn-secondary" onClick={cancel} disabled={step.kind === 'saving'}>Cancel</button>
            {importable > 0 && <button className="btn-primary" onClick={() => void submit()} disabled={step.kind === 'saving'}>{step.kind === 'saving' ? 'Saving…' : 'Submit'}</button>}
          </>}>
          <p className="muted small">
            {step.fileName} · {money(p.totalCents)} in new orders
            {p.existing > 0 && ` · ${p.existing} already loaded`}
            {p.links.new > 0 && ` · ${p.links.new} for new customers (they'll be created)`}
            {p.links.unlinked > 0 && ` · ${p.links.unlinked} with no customer phone/email (skipped)`}
            {p.invalid.length > 0 && ` · ${p.invalid.length} invalid rows`}
          </p>
          {p.newOrders.length > 0 ? (
            <ul className="rows import-list" aria-label="New orders">
              {p.newOrders.map(o => (
                <li key={o.orderId} className={`row ${o.link === 'unlinked' ? 'disabled' : ''}`}>
                  <div className="row-main"><div>
                    <div className="row-title">#{o.orderId} · {money(o.totalCents)} <span className={`tag ${o.link === 'unlinked' ? 'warn' : ''}`}>{LINK[o.link]}</span></div>
                    <div className="muted small">{[new Date(o.at).toLocaleDateString(), o.customer, o.itemSummary].filter(Boolean).join(' · ')}</div>
                  </div></div>
                </li>
              ))}
              {p.newOrderCount > p.newOrders.length && <li className="muted small">…and {p.newOrderCount - p.newOrders.length} more</li>}
            </ul>
          ) : <p>Every order in this file is already loaded (or the rows were invalid).</p>}
          {p.invalid.length > 0 && (
            <details className="small"><summary>{p.invalid.length} invalid row{p.invalid.length === 1 ? '' : 's'} won't be added</summary>
              <ul>{p.invalid.slice(0, 50).map(r => <li key={r.row}>Row {r.row}: {r.reason}</li>)}</ul>
            </details>
          )}
          {err && <p className="error" role="alert">{err}</p>}
        </Modal>
      )}

      {step.kind === 'done' && (
        <Modal title="Orders added" onClose={cancel} actions={<button className="btn-primary" onClick={cancel}>OK</button>}>
          <p>Added {step.inserted} order{step.inserted === 1 ? '' : 's'} to purchase history.
            {step.customersCreated > 0 && ` Created ${step.customersCreated} new customer${step.customersCreated === 1 ? '' : 's'}.`}
            {step.existing > 0 && ` ${step.existing} were already loaded.`}
            {step.unlinked > 0 && ` ${step.unlinked} had no customer and were skipped.`}</p>
        </Modal>
      )}
    </section>
  )
}
