import { useEffect, useState } from 'react'
import { Flame } from 'lucide-react'
import { api } from '../api'
import { useAuth } from '../auth/AuthProvider'
import { PageShell } from '../components/PageShell'
import { initials, money, monthLabel, pct } from '../lib/format'
import type { Period, PerformanceReport } from '../types'
import { MetricCard } from '../components/MetricCard'
import { ErrorBubble } from '../components/ErrorBubble'
import { friendlyError } from '../lib/errors'

const PERIODS: Array<{ id: Period; label: string }> = [
  { id: 'today', label: 'Today' }, { id: 'week', label: 'This week' }, { id: 'month', label: 'This month' }, { id: 'all', label: 'All time' },
]
const MEDALS = ['🥇', '🥈', '🥉']

export function PerformancePage() {
  const auth = useAuth()
  const [r, setR] = useState<PerformanceReport | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [period, setPeriod] = useState<Period>('week')
  useEffect(() => { api.metrics.performance().then(setR, e => setErr(friendlyError(e))) }, [auth.orgId])
  return (
    <PageShell title="Performance metrics" wide
      subtitle={r ? <>A purchase within {r.attributionDays} days of a send counts as a conversion{r.demo && <span className="pill demo">includes demo data</span>}</> : 'Revenue from outreach'}>
      {err ? <ErrorBubble error={err} /> : !r ? <p className="muted">Loading…</p> : <>
        <Overview r={r} />
        <Promotions r={r} />
        <section className="panel leaderboard" aria-label="Staff leaderboard">
          <div className="panel-head">
            <h3>Leaderboard</h3>
            <div className="tabs" role="tablist" aria-label="Period">
              {PERIODS.map(p => (
                <button key={p.id} role="tab" aria-selected={period === p.id} className={period === p.id ? 'active' : ''} onClick={() => setPeriod(p.id)}>{p.label}</button>
              ))}
            </div>
          </div>
          <Leaderboard r={r} period={period} />
        </section>
      </>}
    </PageShell>
  )
}

function Overview({ r }: { r: PerformanceReport }) {
  const s = r.summary
  const g = s.monthGrowthPct
  return (
    <section className="panel" aria-label="Revenue growth">
      <h3>Attributed revenue</h3>
      <div className="metric-grid">
        <MetricCard label={`Month to date (${s.monthDay} day${s.monthDay === 1 ? '' : 's'})`} value={money(s.thisMonthCents)}
          delta={g == null ? undefined : { pct: g }}
          note={g == null ? 'no revenue in the same days last month' : `vs ${money(s.lastMonthToDateCents)} same days last month`} />
        <MetricCard label="Year to date" value={money(s.ytdCents)} note={`${s.ytdConversions.toLocaleString()} conversions · ${s.ytdSends.toLocaleString()} sends`} />
        <MetricCard label="Conversion rate" value={pct(s.conversionRate)} note="year to date" />
        <MetricCard label="Avg order (converted)" value={money(s.avgOrderCents)} note={`full last month ${money(s.lastMonthCents)}`} />
      </div>
      <TrendChart points={r.trend} />
    </section>
  )
}

/** Tiny dependency-free SVG bar chart of attributed revenue per month. */
export function TrendChart({ points }: { points: PerformanceReport['trend'] }) {
  const max = Math.max(1, ...points.map(p => p.revenueCents))
  const W = 320, H = 90, gap = 10, bw = (W - gap * (points.length - 1)) / Math.max(points.length, 1)
  const summary = points.map(p => `${monthLabel(p.month, 'short')} ${money(p.revenueCents)}`).join(', ')
  return (
    <figure className="trend">
      <svg viewBox={`0 0 ${W} ${H + 16}`} role="img" aria-label={`Revenue trend: ${summary}`}>
        {points.map((p, i) => {
          const h = Math.max(2, (p.revenueCents / max) * H)
          return (
            <g key={p.month}>
              <rect x={i * (bw + gap)} y={H - h} width={bw} height={h} rx={4} className={i === points.length - 1 ? 'bar current' : 'bar'}>
                <title>{`${monthLabel(p.month)}: ${money(p.revenueCents)} · ${p.conversions}/${p.sends} converted`}</title>
              </rect>
              <text x={i * (bw + gap) + bw / 2} y={H + 13} textAnchor="middle" className="axis">{monthLabel(p.month, 'short')}</text>
            </g>
          )
        })}
      </svg>
    </figure>
  )
}

function Promotions({ r }: { r: PerformanceReport }) {
  return (
    <section className="panel" aria-label="Promotions">
      <h3>Promotions <span className="muted small">(this year)</span></h3>
      {r.promotions.length === 0 ? <p className="muted">No sends yet.</p> : (
        <div className="table-wrap">
          <table className="table metrics">
            <thead><tr><th>Promotion</th><th>Usage</th><th className="num">Sends</th><th className="num">Conversions</th><th className="num">Conv. rate</th><th className="num">Revenue</th></tr></thead>
            <tbody>
              {r.promotions.map(p => (
                <tr key={p.title}>
                  <td className={p.dealId || p.title !== 'No promotion' ? '' : 'muted'}>{p.title}</td>
                  <td><div className="bar-cell"><div className="progress" aria-hidden><span style={{ width: `${Math.min(100, p.usagePct)}%` }} /></div>{p.usagePct.toFixed(1)}%</div></td>
                  <td className="num">{p.sends.toLocaleString()}</td>
                  <td className="num">{p.conversions.toLocaleString()}</td>
                  <td className="num">{pct(p.conversionRate)}</td>
                  <td className="num">{money(p.revenueCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function Leaderboard({ r, period }: { r: PerformanceReport; period: Period }) {
  const { rows, totals } = r.leaderboard[period]
  const top = Math.max(1, ...rows.map(x => x.conversions))
  if (!rows.length) return <p className="muted">No sends in this period yet.</p>
  return (
    <div className="table-wrap">
      <table className="table metrics">
        <thead><tr><th>#</th><th>Team member</th><th className="num">Sends</th><th>Conversions</th><th className="num">Conv. rate</th><th className="num">Revenue</th></tr></thead>
        <tbody>
          {rows.map((x, i) => (
            <tr key={x.userKey} className={x.isMe ? 'me' : ''}>
              <td className="rank">{i < 3 && x.conversions > 0 ? <span aria-label={`Rank ${i + 1}`}>{MEDALS[i]}</span> : i + 1}</td>
              <td>
                <span className="who">
                  <span className="avatar sm" aria-hidden>{initials(x.name)}</span>
                  <span>{x.name}{x.isMe && <span className="muted"> (you)</span>}</span>
                  {x.onFire && <span className="tag fire" title="30%+ conversion on 5+ sends"><Flame size={13} aria-hidden /> On fire</span>}
                  {x.streakDays >= 3 && <span className="tag streak" title="Consecutive days with sends">{x.streakDays}-day streak</span>}
                </span>
              </td>
              <td className="num">{x.sends.toLocaleString()}</td>
              <td><div className="bar-cell"><div className="progress" aria-hidden><span style={{ width: `${(x.conversions / top) * 100}%` }} /></div>{x.conversions.toLocaleString()}</div></td>
              <td className="num">{pct(x.conversionRate)}</td>
              <td className="num">{x.revenueCents == null ? <span className="muted" title="Only owners and admins see others' revenue">—</span> : money(x.revenueCents)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr><th /><th>All team members</th><td className="num">{totals.sends.toLocaleString()}</td><td>{totals.conversions.toLocaleString()}</td>
          <td className="num">{pct(totals.conversionRate)}</td><td className="num">{r.revenueVisible && totals.revenueCents != null ? money(totals.revenueCents) : '—'}</td></tr></tfoot>
      </table>
    </div>
  )
}
