import { canonical, parseCsv, toIso, toOrders } from "../sync/quickvee/normalize.js";
import type { Order } from "../sync/types.js";
import { ImportError, isExisting, type ExistingKeys } from "../customers/csvImport.js";
import { maskRecipient } from "../domain.js";

/**
 * The order-history CSV format: one row per line item, order columns repeated on each row. This is what
 * `npm run scrape:quickvee:orders` writes and what Data sync → Manually add (orders) accepts. Other headers work when they
 * match the Quickvee aliases (src/sync/quickvee/selectors.ts → CSV_ALIASES). Amount spent is `order_total_paid` (aliases: Total, order total, …); never summed from line items.
 */
export const ORDER_CSV_HEADERS = ["Order ID", "Date", "Customer ID", "Customer name", "Phone", "Email", "Item", "SKU", "Category", "Brand",
  "Qty", "Unit price", "Item discount", "Order discount", "Subtotal", "order_total_paid", "Payment", "Status"] as const;

export const MAX_ORDER_ROWS = 50_000;
export type OrderParse = { orders: Order[]; invalid: Array<{ row: number; reason: string }> };

export function parseOrderCsv(text: string, opts: { tz?: string } = {}): OrderParse {
  let raw: Record<string, string>[];
  try { raw = parseCsv(text); } catch (e) {
    throw new ImportError(`Couldn't read the CSV: ${e instanceof Error ? e.message.split("\n")[0] : "invalid format"}`);
  }
  if (!raw.length) throw new ImportError("The CSV has no data rows.");
  if (raw.length > MAX_ORDER_ROWS) throw new ImportError(`Too many rows (${raw.length}); the limit is ${MAX_ORDER_ROWS} per upload.`);
  const first = canonical(raw[0]);
  if (!("orderId" in first) && !Object.keys(raw[0]).some(h => /order\s*(id|#|number|no)/i.test(h))) throw new ImportError("The CSV needs an Order ID column.");
  if (!("date" in first) && !Object.keys(raw[0]).some(h => /date/i.test(h))) throw new ImportError("The CSV needs a Date column.");
  const invalid: OrderParse["invalid"] = [];
  const valid: Record<string, string>[] = [];
  raw.forEach((r, i) => {
    const c = canonical(r);
    if (!c.orderId) invalid.push({ row: i + 1, reason: "Missing order ID" });
    else if (!toIso(c.date, opts.tz)) invalid.push({ row: i + 1, reason: c.date ? `Invalid date "${c.date.slice(0, 30)}"` : "Missing date" });
    else valid.push(r);
  });
  return { orders: toOrders(valid, opts.tz), invalid };
}

export type CustomerLink = "existing" | "new" | "unlinked";
/** existing: matches a saved customer; new: has a phone/email, so a customer is created; unlinked: walk-in with no contact (skipped). */
export function linkOf(o: Order, keys: ExistingKeys): CustomerLink {
  if (isExisting({ externalId: o.customer.externalId, phone: o.customer.phone, email: o.customer.email }, keys)) return "existing";
  return o.customer.phone || o.customer.email ? "new" : "unlinked";
}

export const toOrderPreview = (o: Order, link: CustomerLink) => ({
  orderId: o.externalId, at: o.at, totalCents: o.totalCents, items: o.items.length,
  itemSummary: o.items.slice(0, 3).map(i => (i.quantity > 1 ? `${i.quantity}× ${i.name}` : i.name)).join(", ") + (o.items.length > 3 ? "…" : ""),
  customer: o.customer.name ?? (o.customer.phone ? maskRecipient(o.customer.phone) : o.customer.email ? maskRecipient(o.customer.email) : null),
  link
});

/** Order → CSV rows in ORDER_CSV_HEADERS order (used by the scraper script). */
export function ordersToCsv(orders: Order[]): string {
  const cell = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const money = (c: number) => (c / 100).toFixed(2);
  const lines = [ORDER_CSV_HEADERS.join(",")];
  for (const o of orders) {
    const base = [o.externalId, o.at, o.customer.externalId, o.customer.name, o.customer.phone, o.customer.email];
    const tail = [money(o.discountCents), money(o.subtotalCents), money(o.totalCents), o.paymentMethod, o.refunded ? "Refunded" : ""];
    const items = o.items.length ? o.items : [null];
    for (const i of items) {
      lines.push([...base, i?.name, i?.sku, i?.category, i?.brand, i ? i.quantity : "", i ? money(i.unitPriceCents) : "", i ? money(i.discountCents) : "", ...tail].map(cell).join(","));
    }
  }
  return lines.join("\n") + "\n";
}
