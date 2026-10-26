export const money = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100)

export const daysAgo = (d: number | null) =>
  d == null ? '—' : d === 0 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`

/** SMS segment math is out of scope; we show raw characters like the mockup. */
export const charCount = (s: string) => [...s].length
