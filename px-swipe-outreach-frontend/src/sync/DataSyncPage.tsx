import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, History, Play, RefreshCw } from 'lucide-react'
import { api, ApiError } from '../api'
import { useAuth } from '../auth/AuthProvider'
import { PageShell } from '../components/PageShell'
import type { SyncFrequency, SyncOverview, SyncRun, SyncSource } from '../types'

const POLL_MS = 2000
const FREQUENCIES: Array<[SyncFrequency, string]> = [['off', 'Off'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['yearly', 'Yearly']]
const TIMEZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'America/Puerto_Rico', 'Europe/London', 'UTC']
const TRIGGER: Record<SyncRun['trigger'], string> = { manual: 'Manual', schedule: 'Scheduled', backfill: 'Backfill', cli: 'CLI' }

/** "Nov 15, 2026, 10:00:00 AM" in the store's timezone. */
export function fmtTime(iso: string | null, tz: string): string {
  if (!iso) return '–'
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(iso))
}
export function fmtDuration(ms: number | null): string {
  if (ms === null) return '–'
  if (ms < 1000) return `${ms} ms`
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}
const today = () => new Date().toISOString().slice(0, 10)

export function DataSyncPage() {
  const auth = useAuth()
  const canManage = auth.role === 'owner' || auth.role === 'admin'
  const [data, setData] = useState<SyncOverview | null>(null)
  const [runs, setRuns] = useState<SyncRun[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [historyFor, setHistoryFor] = useState<SyncSource['id'] | ''>('')

  const load = useCallback(async () => {
    try {
      const [o, r] = await Promise.all([api.sync.overview(), api.sync.runs(historyFor || undefined)])
      setData(o); setRuns(r); setErr(null)
    } catch (e) { setErr((e as Error).message) }
  }, [historyFor])
  useEffect(() => { if (canManage) void load() }, [canManage, load])

  // Live progress: poll while anything is running.
  const running = data?.sources.some(s => s.lastRun?.status === 'running') ?? false
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(t)
  }, [running, load])

  return (
    <PageShell title="Data sync" wide
      subtitle={data ? <>Pull usage, costs, email status and Quickvee rewards/orders into Outreach · times in {data.timezone}{!data.schedulerEnabled && <span className="pill warn">scheduler off on this server</span>}</> : 'Keep outside data in sync'}>
      {!canManage ? <p className="error" role="alert">Only owners and admins can manage data sync.</p>
        : err && !data ? <p className="error" role="alert">{err}</p>
        : !data ? <p className="muted">Loading…</p>
        : <>
          {err && <p className="error" role="alert">{err}</p>}
          <TimezonePanel tz={data.timezone} onSaved={load} />
          <div className="sync-grid">
            {data.sources.map(s => <SourceCard key={s.id} source={s} tz={data.timezone} onChange={load} />)}
          </div>
          <section className="panel" aria-label="Run history">
            <div className="row-between">
              <h3><History size={17} aria-hidden /> Run history</h3>
              <select aria-label="Filter run history" value={historyFor} onChange={e => setHistoryFor(e.target.value as SyncSource['id'] | '')}>
                <option value="">All sources</option>
                {data.sources.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </div>
            <RunHistory runs={runs} tz={data.timezone} labels={Object.fromEntries(data.sources.map(s => [s.id, s.label]))} />
          </section>
          <p className="muted small">Credentials live only in the server's environment and are never shown here. Runs happen in the background on the server; one run per source at a time.
            Quickvee is scraped with your own merchant login only.</p>
        </>}
    </PageShell>
  )
}

function TimezonePanel({ tz, onSaved }: { tz: string; onSaved: () => void }) {
  const [value, setValue] = useState(tz)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => setValue(tz), [tz])
  const options = TIMEZONES.includes(tz) ? TIMEZONES : [tz, ...TIMEZONES]
  return (
    <section className="panel sync-tz" aria-label="Store timezone">
      <label>Store timezone{' '}
        <select value={value} onChange={e => setValue(e.target.value)}>{options.map(z => <option key={z} value={z}>{z}</option>)}</select>
      </label>
      <button className="btn-small" disabled={saving || value === tz} onClick={async () => {
        setSaving(true); setMsg(null)
        try { await api.sync.timezone(value); setMsg('Saved'); onSaved() } catch (e) { setMsg((e as Error).message) } finally { setSaving(false) }
      }}>Save timezone</button>
      {msg && <span className="muted small" role="status">{msg}</span>}
      <span className="muted small">Schedules run at their local time in this zone, including across daylight saving changes.</span>
    </section>
  )
}

function statusOf(s: SyncSource): { label: string; cls: string } {
  if (!s.configured) return { label: 'Not configured', cls: 'muted' }
  const r = s.lastRun
  if (!r) return { label: 'Never run', cls: 'muted' }
  if (r.status === 'running') return { label: 'Running', cls: 'running' }
  return r.status === 'succeeded' ? { label: 'Up to date', cls: 'ok' } : { label: 'Failed', cls: 'failed' }
}

function SourceCard({ source: s, tz, onChange }: { source: SyncSource; tz: string; onChange: () => void }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [freq, setFreq] = useState<SyncFrequency>(s.schedule.frequency)
  const [date, setDate] = useState(s.schedule.startLocal.slice(0, 10))
  const [time, setTime] = useState(s.schedule.startLocal.slice(11, 19))
  const [from, setFrom] = useState('')
  const [to, setTo] = useState(today())
  const st = statusOf(s)
  const r = s.lastRun
  const isRunning = r?.status === 'running'
  const dirty = freq !== s.schedule.frequency || `${date}T${time}` !== s.schedule.startLocal

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true); setMsg(null)
    try { await fn(); setMsg(ok); onChange() }
    catch (e) { setMsg(e instanceof ApiError ? e.message : 'Something went wrong') }
    finally { setBusy(false) }
  }
  const pct = r?.progress.total ? Math.min(100, Math.round(((r.progress.done ?? 0) / r.progress.total) * 100)) : null

  return (
    <section className="panel sync-card" aria-label={s.label}>
      <div className="row-between">
        <h3>{s.label}</h3>
        <span className={`sync-status ${st.cls}`}>{st.label}</span>
      </div>
      <p className="muted small">{s.description}</p>
      {!s.configured && <p className="small" role="note">Set <code>{s.missing.join(', ')}</code> in the server environment to enable this source.</p>}

      {isRunning && r && (
        <div className="sync-progress" role="status" aria-label={`${s.label} progress`}>
          <span>{r.progress.phase ?? 'Starting'}{r.progress.total ? ` · ${r.progress.done ?? 0}/${r.progress.total}` : r.progress.done ? ` · ${r.progress.done}` : ''}</span>
          <div className="bar"><div style={{ width: `${pct ?? 15}%` }} className={pct === null ? 'indeterminate' : undefined} /></div>
        </div>
      )}

      <dl className="sync-facts">
        <div><dt>Last run</dt><dd>{r ? fmtTime(r.startedAt, tz) : '–'}</dd></div>
        <div><dt>Duration</dt><dd>{r ? (isRunning ? 'running…' : fmtDuration(r.durationMs)) : '–'}</dd></div>
        <div><dt>Rows</dt><dd>{r ? `${r.rowsRead.toLocaleString()} read · ${r.rowsWritten.toLocaleString()} written${r.dryRun ? ' (dry run)' : ''}` : '–'}</dd></div>
        <div><dt>Next scheduled run</dt><dd>{s.schedule.frequency === 'off' ? 'Not scheduled' : fmtTime(s.schedule.nextRunAt, tz)}</dd></div>
      </dl>
      {r?.status === 'failed' && r.error && <p className="error small" role="alert">Last error: {r.error}</p>}

      <div className="sync-actions">
        <button className="btn-small" disabled={!s.configured || busy || isRunning}
          onClick={() => act(() => api.sync.run(s.id), 'Re-sync started')}>
          <RefreshCw size={14} aria-hidden /> Force re-sync
        </button>
      </div>

      {s.supportsBackfill && (
        <fieldset className="sync-backfill" disabled={!s.configured || busy || isRunning}>
          <legend>Backfill history</legend>
          <label>From <input type="date" value={from} max={to || today()} onChange={e => setFrom(e.target.value)} /></label>
          <label>To <input type="date" value={to} max={today()} onChange={e => setTo(e.target.value)} /></label>
          <button className="btn-small" disabled={!from || !to || from > to}
            onClick={() => act(() => api.sync.run(s.id, { from, to }), `Backfill ${from} → ${to} started`)}>
            <Play size={14} aria-hidden /> Backfill history
          </button>
        </fieldset>
      )}

      <fieldset className="sync-schedule" disabled={busy}>
        <legend>Schedule</legend>
        <label>Frequency{' '}
          <select value={freq} onChange={e => setFreq(e.target.value as SyncFrequency)}>
            {FREQUENCIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label>Starting <input type="date" aria-label={`${s.label} start date`} value={date} onChange={e => setDate(e.target.value)} disabled={freq === 'off'} /></label>
        <label>at <input type="time" step={1} aria-label={`${s.label} start time`} value={time} onChange={e => setTime(e.target.value.length === 5 ? `${e.target.value}:00` : e.target.value)} disabled={freq === 'off'} /></label>
        <button className="btn-small" disabled={!dirty || !date || !time}
          onClick={() => act(() => api.sync.schedule(s.id, freq, `${date}T${time}`), freq === 'off' ? 'Schedule turned off' : 'Schedule saved')}>Save schedule</button>
      </fieldset>
      {msg && <p className="muted small" role="status">{msg}</p>}
    </section>
  )
}

function RunHistory({ runs, tz, labels }: { runs: SyncRun[]; tz: string; labels: Record<string, string> }) {
  const [open, setOpen] = useState<string | null>(null)
  if (!runs.length) return <p className="muted">No runs yet.</p>
  return (
    <div className="table-wrap">
      <table className="table sync-runs">
        <thead><tr><th aria-label="Expand" /><th>Source</th><th>Trigger</th><th>Status</th><th>Started</th><th>Duration</th><th>Rows</th></tr></thead>
        <tbody>
          {runs.map(r => [
            <tr key={r.id}>
              <td><button className="icon-btn" aria-expanded={open === r.id} aria-label={`${open === r.id ? 'Hide' : 'Show'} log for ${labels[r.job]} run`}
                onClick={() => setOpen(o => (o === r.id ? null : r.id))}>{open === r.id ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button></td>
              <td>{labels[r.job] ?? r.job}</td>
              <td>{TRIGGER[r.trigger]}{r.params.from ? ` ${r.params.from} → ${r.params.to}` : ''}{r.dryRun ? ' (dry run)' : ''}</td>
              <td><span className={`sync-status ${r.status === 'succeeded' ? 'ok' : r.status}`}>{r.status === 'succeeded' ? 'Succeeded' : r.status === 'failed' ? 'Failed' : 'Running'}</span></td>
              <td>{fmtTime(r.startedAt, tz)}</td>
              <td>{r.status === 'running' ? '…' : fmtDuration(r.durationMs)}</td>
              <td>{r.rowsRead.toLocaleString()} / {r.rowsWritten.toLocaleString()}</td>
            </tr>,
            open === r.id && <tr key={`${r.id}-log`} className="log-row"><td colSpan={7}><RunLog id={r.id} tz={tz} live={r.status === 'running'} /></td></tr>,
          ])}
        </tbody>
      </table>
    </div>
  )
}

function RunLog({ id, tz, live }: { id: string; tz: string; live: boolean }) {
  const [run, setRun] = useState<SyncRun | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    const get = () => api.sync.runDetail(id).then(r => { if (alive.current) setRun(r) }, e => setErr((e as Error).message))
    void get()
    const t = live ? setInterval(get, POLL_MS) : null
    return () => { alive.current = false; if (t) clearInterval(t) }
  }, [id, live])
  if (err) return <p className="error small">{err}</p>
  if (!run) return <p className="muted small">Loading log…</p>
  return (
    <ol className="sync-log" aria-label="Run log">
      {(run.log ?? []).map((l, i) => (
        <li key={i} className={l.level}>
          <time>{fmtTime(l.at, tz).split(', ').pop()}</time> <span className="lvl">{l.level}</span> {l.msg}
          {l.data && <code>{JSON.stringify(l.data)}</code>}
        </li>
      ))}
      {!run.log?.length && <li className="muted">No log lines.</li>}
    </ol>
  )
}
