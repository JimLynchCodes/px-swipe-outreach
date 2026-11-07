import { parse } from "csv-parse/sync";
import { CSV_ALIASES } from "./selectors.js";
import type { Order, RewardsMember } from "../types.js";
import { zonedToUtc } from "../schedule.js";

const key = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");
/** Maps a row with arbitrary headers onto our field names via CSV_ALIASES. */
export function canonical(row: Record<string, string>): Record<string, string> {
  const byKey = new Map(Object.entries(row).map(([k, v]) => [key(k), String(v ?? "").trim()]));
  const out: Record<string, string> = {};
  for (const [field, aliases] of Object.entries(CSV_ALIASES)) for (const a of aliases) if (byKey.get(a)) { out[field] = byKey.get(a)!; break; }
  return out;
}
export const parseCsv = (text: string): Record<string, string>[] => parse(text, { columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: true });

/** "$1,234.56" / "(3.00)" / "-3" → cents (absolute for discounts handled by caller). */
export function toCents(v: string | undefined): number {
  if (!v) return 0;
  const neg = /^\(.*\)$/.test(v.trim()) || v.trim().startsWith("-");
  const n = Number(v.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) * (neg ? -1 : 1) : 0;
}
/** US-centric E.164; null if it doesn't look like a phone. */
export function normalizePhone(v: string | undefined | null): string | null {
  if (!v) return null;
  const d = v.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return d.length >= 8 && d.length <= 15 && v.trim().startsWith("+") ? `+${d}` : null;
}
export const normalizeEmail = (v: string | undefined | null) => (v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? v.trim().toLowerCase() : null);
/**
 * Portal dates are store-local wall times: "11/05/2026", "11/05/2026 3:04 PM", "2026-11-05", "2026-11-05 18:40".
 * Converted to UTC with the store timezone. Date-only values use local noon (no day drift). Values with an explicit
 * offset/Z are taken as-is.
 */
export function toIso(v: string | undefined, tz = "America/New_York"): string | null {
  if (!v) return null;
  const s = v.trim();
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i.exec(s);
  const isoLocal = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  let f: { y: number; m: number; d: number; h: number; mi: number; s: number } | null = null;
  if (us) {
    let h = us[4] ? Number(us[4]) : 12;
    if (us[7]) h = (h % 12) + (us[7].toUpperCase() === "PM" ? 12 : 0);
    f = { y: us[3].length === 2 ? 2000 + Number(us[3]) : Number(us[3]), m: Number(us[1]), d: Number(us[2]), h, mi: Number(us[5] ?? 0), s: Number(us[6] ?? 0) };
  } else if (isoLocal) {
    f = { y: +isoLocal[1], m: +isoLocal[2], d: +isoLocal[3], h: isoLocal[4] ? +isoLocal[4] : 12, mi: Number(isoLocal[5] ?? 0), s: Number(isoLocal[6] ?? 0) };
  }
  if (f) return f.m >= 1 && f.m <= 12 && f.d >= 1 && f.d <= 31 && f.h < 24 ? new Date(zonedToUtc(f, tz)).toISOString() : null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}
export function splitName(full: string | undefined): [string | null, string | null] {
  const parts = (full ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return [null, null];
  return [parts[0], parts.length > 1 ? parts.slice(1).join(" ") : null];
}

export function toRewardsMember(raw: Record<string, string>, tz?: string): RewardsMember | null {
  const r = canonical(raw);
  const phone = normalizePhone(r.phone), email = normalizeEmail(r.email);
  const [first, last] = r.firstName || r.lastName ? [r.firstName || null, r.lastName || null] : splitName(r.name);
  const externalId = r.id || phone || email;
  if (!externalId) return null;
  const pts = r.points ? Math.max(0, Math.round(Number(r.points.replace(/[^0-9.-]/g, "")))) : null;
  return { externalId, firstName: first, lastName: last, phone, email, points: Number.isFinite(pts) ? pts : null, joinedAt: r.joined ? (/^\d{4}-\d{2}-\d{2}/.exec(r.joined)?.[0] ?? toIso(r.joined, tz)?.slice(0, 10) ?? null) : null };
}

/** Groups line-item CSV rows (one row per item, order columns repeated) into orders. */
export function toOrders(rows: Record<string, string>[], tz?: string): Order[] {
  const orders = new Map<string, Order>();
  for (const raw of rows) {
    const r = canonical(raw);
    if (!r.orderId) continue;
    let o = orders.get(r.orderId);
    if (!o) {
      const at = toIso(r.date, tz);
      if (!at) continue;
      o = { externalId: r.orderId, at, customer: { externalId: r.id || null, name: r.name || null, phone: normalizePhone(r.phone), email: normalizeEmail(r.email) },
        items: [], subtotalCents: toCents(r.subtotal), discountCents: Math.abs(toCents(r.orderDiscount)), totalCents: toCents(r.total), paymentMethod: r.payment || null };
      orders.set(r.orderId, o);
    }
    if (r.item) o.items.push({ name: r.item, sku: r.sku || null, category: r.category || null, brand: r.brand || null,
      quantity: Math.max(1, Math.round(Number(r.qty) || 1)), unitPriceCents: Math.abs(toCents(r.unitPrice)), discountCents: Math.abs(toCents(r.itemDiscount)) });
  }
  for (const o of orders.values()) if (!o.subtotalCents) o.subtotalCents = o.items.reduce((s, i) => s + i.quantity * i.unitPriceCents, 0);
  return [...orders.values()];
}
