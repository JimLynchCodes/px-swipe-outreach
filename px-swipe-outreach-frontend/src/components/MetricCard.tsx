import type { ReactNode } from 'react'

export type Trend = 'up' | 'down' | 'neutral'

/** Summary stat: small uppercase label, big tabular value, and an optional subtle line/pill underneath. */
export function MetricCard({ label, value, delta, note }: {
  label: string; value: string
  /** Growth pill (green ▲ / red ▼). */
  delta?: { pct: number; text?: string }
  /** Neutral gray context, e.g. "vs $2,910 last month". */
  note?: ReactNode
}) {
  const trend: Trend | null = delta ? (delta.pct > 0 ? 'up' : delta.pct < 0 ? 'down' : 'neutral') : null
  return (
    <div className="metric-card">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {(delta || note) && (
        <div className="metric-sub">
          {delta && <span className={`metric-pill ${trend}`}>{trend === 'up' ? '▲' : trend === 'down' ? '▼' : '•'} {Math.abs(delta.pct).toFixed(1)}%{delta.text ? ` ${delta.text}` : ''}</span>}
          {note && <span className="metric-note">{note}</span>}
        </div>
      )}
    </div>
  )
}
