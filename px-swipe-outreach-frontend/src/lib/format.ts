export const money = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100)

export const daysAgo = (d: number | null) =>
  d == null ? '—' : d === 0 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`

/** SMS segment math is out of scope; we show raw characters like the mockup. */
export const charCount = (s: string) => [...s].length

/** Must match the backend's SMS_MAX (src/domain.ts). */
export const SMS_MAX = 480
export const SMS_OPT_OUT = 'Reply STOP to opt out.'

export const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => [...w][0]!.toUpperCase()).join('') || '?'

/** USD with sub-cent precision for tiny AI costs: $0 / $0.000195 / $0.0123 / $1.23 / $1,234. */
export function usd(v: number): string {
  if (v === 0) return '$0.00'
  const abs = Math.abs(v)
  const digits = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v)
}
export const pct = (ratio: number, digits = 1) => `${(ratio * 100).toFixed(digits)}%`
export const compact = (n: number) => new Intl.NumberFormat('en-US', { notation: n >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n)
export function monthLabel(key: string, style: 'long' | 'short' = 'long') {
  const [y, m] = key.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleString('en-US', { month: style, ...(style === 'long' ? { year: 'numeric' } : {}) })
}

/** Compact "12d ago" / "today" / "never" for an ISO timestamp. */
export function sinceShort(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never'
  const days = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 86_400_000))
  return days === 0 ? 'today' : `${days}d ago`
}

/** "Nov 11" for an ISO timestamp. */
export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
