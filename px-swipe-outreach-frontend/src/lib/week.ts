import type { DealInput } from '../types'

export const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const
export const DAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const
/** JS getDay() (0 = Sunday) → 0 = Monday. */
export const todayIndex = (d = new Date()) => (d.getDay() + 6) % 7

export function discountLabel(d: Pick<DealInput, 'discountType' | 'discountValue'>): string {
  switch (d.discountType) {
    case 'percent': return `${d.discountValue ?? 0}% off`
    case 'amount': return `$${((d.discountValue ?? 0) / 100).toFixed((d.discountValue ?? 0) % 100 ? 2 : 0)} off`
    case 'bogo': return 'Buy one, get one'
    case 'freebie': return 'Free gift'
  }
}

export const CATEGORY_LABEL: Record<string, string> = {
  vape: 'Vape', cbd: 'CBD', glass: 'Glass', papers: 'Papers & cones', cigars: 'Cigars', hookah: 'Hookah', accessories: 'Accessories',
}
export const categoryLabel = (c: string) => CATEGORY_LABEL[c] ?? c
export const SEGMENT_LABEL = { loyal: 'Loyal', at_risk: 'At risk', lapsed: 'Lapsed' } as const

export function relativeTime(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 7 * 86400) return DAYS_SHORT[todayIndex(new Date(iso))]
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const dayNumber = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86_400_000
const localIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Status of a date-range promotion relative to today: "Starts in 3 days", "12 days left", "Last day", "Ended". */
export function rangeStatus(startsOn: string | null, endsOn: string | null, now = new Date()): { label: string; state: 'upcoming' | 'running' | 'ended' } {
  const today = dayNumber(localIso(now))
  if (startsOn && dayNumber(startsOn) > today) {
    const n = dayNumber(startsOn) - today
    return { label: n === 1 ? 'Starts tomorrow' : `Starts in ${n} days`, state: 'upcoming' }
  }
  if (endsOn && dayNumber(endsOn) < today) return { label: 'Ended', state: 'ended' }
  if (!endsOn) return { label: 'Ongoing', state: 'running' }
  const left = dayNumber(endsOn) - today
  return { label: left === 0 ? 'Last day' : `${left} day${left === 1 ? '' : 's'} left`, state: 'running' }
}

/** "Nov 20 – Dec 31" (adds the year when it isn't this year). */
export function formatRange(startsOn: string | null, endsOn: string | null, now = new Date()): string {
  const fmt = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number)
    return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(y !== now.getFullYear() ? { year: 'numeric' } : {}) })
  }
  return `${startsOn ? fmt(startsOn) : '…'} – ${endsOn ? fmt(endsOn) : '…'}`
}
