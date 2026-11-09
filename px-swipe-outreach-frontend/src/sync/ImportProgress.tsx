/** Accessible progress for Data sync CSV upload / parse / write. */
export type ImportProgressState = {
  phase: 'reading' | 'uploading' | 'parsing' | 'writing'
  /** 0–100 when known; null = indeterminate */
  percent: number | null
  done?: number
  total?: number
  label?: string
}

const PHASE_LABEL: Record<ImportProgressState['phase'], string> = {
  reading: 'Reading file…',
  uploading: 'Uploading…',
  parsing: 'Parsing…',
  writing: 'Saving…',
}

export function ImportProgress({ progress }: { progress: ImportProgressState }) {
  const indeterminate = progress.percent === null
  const pct = indeterminate ? undefined : Math.max(0, Math.min(100, progress.percent ?? 0))
  const rows = progress.total != null && progress.done != null
    ? `${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} rows`
    : null
  const label = progress.label ?? PHASE_LABEL[progress.phase]
  const text = [label, pct != null ? `${pct}%` : null, rows].filter(Boolean).join(' · ')

  return (
    <div className="import-progress sync-progress" role="progressbar"
      aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : pct}
      aria-valuetext={text}
      aria-label={text}>
      <span>{text}</span>
      <div className="bar">
        <div style={{ width: `${indeterminate ? 30 : pct}%` }} className={indeterminate ? 'indeterminate' : undefined} />
      </div>
    </div>
  )
}
