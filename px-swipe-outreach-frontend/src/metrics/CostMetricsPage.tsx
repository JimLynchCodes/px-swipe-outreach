import { useEffect, useState } from 'react'
import { api } from '../api'
import { useAuth } from '../auth/AuthProvider'
import { PageShell } from '../components/PageShell'
import { compact, monthLabel, usd } from '../lib/format'
import { MetricCard } from '../components/MetricCard'
import type { CostReport, ModelCost } from '../types'

export function CostMetricsPage() {
  const auth = useAuth()
  const canView = auth.role === 'owner' || auth.role === 'admin'
  const [r, setR] = useState<CostReport | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => { if (canView) api.metrics.costs().then(setR, e => setErr(e.message)) }, [canView])
  return (
    <PageShell title="Cost metrics" wide
      subtitle={r ? <>AI spend for {r.year} · prices v{r.priceTableVersion}{r.demo && <span className="pill demo">includes demo data</span>}</> : 'AI spend per model and month'}>
      {!canView ? <p className="error" role="alert">Only owners and admins can view cost metrics.</p>
        : err ? <p className="error" role="alert">{err}</p>
        : !r ? <p className="muted">Loading…</p>
        : <>
          <section className="panel" aria-label="Year to date">
            <h3>Year to date</h3>
            <div className="metric-grid">
              <MetricCard label="Total AI spend" value={usd(r.ytd.costUsd)} note="year to date" />
              <MetricCard label="Messages sent" value={r.ytd.messagesSent.toLocaleString()} note={r.ytd.messagesSent ? `${usd(r.ytd.costUsd / r.ytd.messagesSent)} AI cost per send` : undefined} />
              <MetricCard label="AI calls" value={r.ytd.aiCalls.toLocaleString()} note={r.ytd.aiCalls ? `${usd(r.ytd.costUsd / r.ytd.aiCalls)} per call` : undefined} />
              <MetricCard label="Calls that led to a send" value={r.ytd.aiCalls ? `${Math.round((r.ytd.messagesSent / r.ytd.aiCalls) * 100)}%` : '–'} note={`${r.ytd.messagesSent.toLocaleString()} of ${r.ytd.aiCalls.toLocaleString()}`} />
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
          <p className="muted small">Costs are priced when each suggestion is made, from the token counts the API returns. “None” (heuristic-based canned suggestions) is free.
            Messages sent are counted against the model that wrote the suggestion.</p>
        </>}
    </PageShell>
  )
}


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
