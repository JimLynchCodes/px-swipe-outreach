/**
 * Schedule math: frequency (off/daily/weekly/monthly/yearly) + a wall-clock start ("2026-11-15T10:00:00") in the store's
 * IANA timezone. Occurrence n = start + n × interval, computed on the local calendar (so 10:00 stays 10:00 across DST)
 * and converted to UTC. Monthly/yearly clamp to the last day of shorter months (Jan 31 → Feb 28/29 → Mar 31; Feb 29 →
 * Feb 28 in non-leap years). DST gaps (02:30 on spring-forward day) move forward by the gap; ambiguous fall-back times
 * use the first occurrence.
 */
export const FREQUENCIES = ["off", "daily", "weekly", "monthly", "yearly"] as const;
export type Frequency = (typeof FREQUENCIES)[number];
export type LocalDateTime = { y: number; m: number; d: number; h: number; mi: number; s: number };

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export function parseLocal(s: string): LocalDateTime | null {
  const m = LOCAL_RE.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi, sec] = [1, 2, 3, 4, 5, 6].map(i => Number(m[i] ?? 0));
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || h > 23 || mi > 59 || sec > 59) return null;
  return { y, m: mo, d, h, mi, s: sec };
}
export const formatLocal = (t: LocalDateTime) =>
  `${t.y}-${pad(t.m)}-${pad(t.d)}T${pad(t.h)}:${pad(t.mi)}:${pad(t.s)}`;
const pad = (n: number) => String(n).padStart(2, "0");

export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    fmtCache.set(tz, f);
  }
  return f;
}
/** Wall-clock fields of an instant in a timezone. */
export function toLocal(ms: number, tz: string): LocalDateTime {
  const p = Object.fromEntries(fmt(tz).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}
const asUtc = (t: LocalDateTime) => Date.UTC(t.y, t.m - 1, t.d, t.h, t.mi, t.s);
const offset = (ms: number, tz: string) => asUtc(toLocal(ms, tz)) - Math.floor(ms / 1000) * 1000;

/** The UTC instant for a wall-clock time in tz (gap → shifted forward; overlap → earlier instant). */
export function zonedToUtc(t: LocalDateTime, tz: string): number {
  const guess = asUtc(t);
  const before = guess - offset(guess - 12 * 3_600_000, tz);
  const after = guess - offset(guess + 12 * 3_600_000, tz);
  const ok = [before, after].filter(c => asUtc(toLocal(c, tz)) === guess).sort((a, b) => a - b);
  return ok[0] ?? before; // gap: the pre-transition offset lands after the jump (e.g. 02:30 → 03:30)
}

/** Local wall-clock time of occurrence n. */
export function occurrenceLocal(start: LocalDateTime, freq: Exclude<Frequency, "off">, n: number): LocalDateTime {
  if (freq === "daily" || freq === "weekly") {
    const day = new Date(Date.UTC(start.y, start.m - 1, start.d + n * (freq === "daily" ? 1 : 7)));
    return { ...start, y: day.getUTCFullYear(), m: day.getUTCMonth() + 1, d: day.getUTCDate() };
  }
  const months = (start.m - 1) + n * (freq === "monthly" ? 1 : 12);
  const y = start.y + Math.floor(months / 12), m = (months % 12) + 1;
  return { ...start, y, m, d: Math.min(start.d, daysInMonth(y, m)) };
}

export function occurrence(start: LocalDateTime, freq: Exclude<Frequency, "off">, n: number, tz: string): number {
  return zonedToUtc(occurrenceLocal(start, freq, n), tz);
}

const APPROX_MS = { daily: 86_400_000, weekly: 7 * 86_400_000, monthly: 28 * 86_400_000, yearly: 365 * 86_400_000 } as const;

/**
 * First occurrence strictly after `afterMs` (or the start itself if it is later). Missed occurrences are skipped, so a
 * scheduler that was down catches up with one run, then resumes the normal cadence. Null when off.
 */
export function nextRunAfter(startLocal: string, freq: Frequency, tz: string, afterMs: number): Date | null {
  if (freq === "off") return null;
  const start = parseLocal(startLocal);
  if (!start) throw new Error(`invalid start: ${startLocal}`);
  const first = occurrence(start, freq, 0, tz);
  if (first > afterMs) return new Date(first);
  // Jump close (estimate never overshoots: APPROX ≤ real interval), then step.
  let n = Math.max(0, Math.floor((afterMs - first) / APPROX_MS[freq]) - 2);
  while (n > 0 && occurrence(start, freq, n, tz) > afterMs) n--;
  for (;; n++) {
    const t = occurrence(start, freq, n, tz);
    if (t > afterMs) return new Date(t);
  }
}
