import { useEffect, useState } from 'react'
import { api } from '../api'
import { useAuth } from '../auth/AuthProvider'
import { PageShell } from '../components/PageShell'
import { compact, monthLabel, usd } from '../lib/format'
import { ROUTES } from '../router'
import { SettingsTabs } from '../settings/SettingsTabs'
import type { CostReport, ModelCost } from '../types'

export function CostMetricsPage() {
  const auth = useAuth()
  const canView = auth.role === 'owner' || auth.role === 'admin'
  const [r, setR] = useState<CostReport | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { if (canView) api.metrics.costs().then(setR, e => setErr(e.message)) }, [canView])
  return (
    <PageShell title="Cost metrics" back={ROUTES.settings} backLabel="Back to settings"
      subtitle={r ? <>AI spend for {r.year} · prices v{r.priceTableVersion}{r.demo && <span className="pill demo">includes demo data</span>}</> : 'AI spend per model and month'}>
      <SettingsTabs current="costs" />
      {!canView ? <p className="error" role="alert">Only owners and admins can view cost metrics.</p>
        : err ? <p className="error" role="alert">{err}</p>
        : !r ? <p className="muted">Loading…</p>
        : <>
          <section className="panel" aria-label="Year to date">
            <h3>Year to date</h3>
            <div className="stat-grid">
              <Stat label="Total AI spend" value={usd(r.ytd.costUsd)} />
              <Stat label="Messages sent" value={r.ytd.messagesSent.toLocaleString()} />
              <Stat label="AI calls" value={r.ytd.aiCalls.toLocaleString()} />
            </div>
            <ModelTable rows={r.ytd.byModel} caption="By model, year to date" />
          </section>
          {r.months.length === 0 && <p className="muted">No AI usage yet this year.</p>}
          {r.months.map(m => (
            <section className="panel" key={m.month} aria-label={monthLabel(m.month)}>
              <h3>{monthLabel(m.month)}</h3>
              <ModelTable rows={m.models} total={m.total} caption={`${monthLabel(m.month)} by model`} />
            </section>
          ))}
          <p className="muted small">Costs are priced when each suggestion is made, from the token counts the API returns. “Rules only” is free.
            Messages sent are counted against the model that wrote the suggestion.</p>
        </>}
    </PageShell>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: React.ReactNode }) {
  return <div className="stat"><div className="stat-value">{value}</div><div className="stat-label">{label}</div>{hint && <div className="stat-hint">{hint}</div>}</div>
}
export { Stat }

function ModelTable({ rows, total, caption }: { rows: ModelCost[]; total?: Omit<ModelCost, 'model' | 'label'>; caption: string }) {
  return (
    <div className="table-wrap">
      <table className="table metrics">
        <caption className="sr-only">{caption}</caption>
        <thead><tr><th>Model</th><th className="num">Messages sent</th><th className="num">AI calls</th><th className="num">Tokens (in / out)</th><th className="num">Spend</th></tr></thead>
        <tbody>
          {rows.map(m => (
            <tr key={m.model}>
              <td>{m.label}</td>
              <td className="num" title={`${m.smsSent} SMS · ${m.emailSent} email`}>{m.messagesSent.toLocaleString()}</td>
              <td className="num">{m.aiCalls.toLocaleString()}</td>
              <td className="num">{compact(m.inputTokens)} / {compact(m.outputTokens)}</td>
              <td className="num">{usd(m.costUsd)}</td>
            </tr>
          ))}
        </tbody>
        {total && (
          <tfoot><tr><th>Month total</th><td className="num">{total.messagesSent.toLocaleString()}</td><td className="num">{total.aiCalls.toLocaleString()}</td>
            <td className="num">{compact(total.inputTokens)} / {compact(total.outputTokens)}</td><td className="num">{usd(total.costUsd)}</td></tr></tfoot>
        )}
      </table>
    </div>
  )
}
