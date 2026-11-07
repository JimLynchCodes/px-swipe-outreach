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
