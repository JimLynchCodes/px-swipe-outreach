import { parseCsv, normalizeEmail, normalizePhone, splitName, toCents, toIso } from "../sync/quickvee/normalize.js";
import { maskRecipient } from "../domain.js";

/** One customer row from an uploaded CSV, normalized. */
export type ImportCustomer = {
  /** CSV row number (1 = first data row). */
  row: number;
  /** POS id, stored as `qv:<id>` in customers.external_id (same key as the Quickvee sync). */
  externalId: string | null;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  location: string | null;
  age: number | null;
  lastPurchaseAt: string | null;
  lifetimeSpendCents: number;
  rewardsPoints: number | null;
  customerSince: string | null;
};
export type InvalidRow = { row: number; reason: string };
export type ParsedImport = { customers: ImportCustomer[]; invalid: InvalidRow[]; duplicatesInFile: number };
export type ExistingKeys = { externalIds: Set<string>; phones: Set<string>; emails: Set<string> };
export type ImportConsent = { smsConsent: boolean; emailConsent: boolean; ageVerified: boolean };

export const MAX_IMPORT_ROWS = 5000;

const k = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");
/** Header aliases (normalized: lowercase alphanumerics). First match wins. Quickvee's customer export is the reference. */
const COLUMNS = {
  id: ["customerid", "id", "memberid", "externalid"],
  firstName: ["firstname", "first"],
  lastName: ["lastname", "last", "surname"],
  name: ["nameonfile", "name", "fullname", "customername"],
  phone: ["phone", "phonenumber", "mobile", "cell"],
  email: ["email", "emailaddress"],
  store: ["store", "location", "storename"],
  city: ["city"],
  state: ["state"],
  dob: ["dateofbirth", "dob", "birthdate", "birthday"],
  since: ["customersince", "joined", "signupdate", "createdat"],
  lastOrder: ["lastorderdate", "lastpurchase", "lastvisit", "lastorder"],
  spend: ["lifetimespend", "totalspend", "lifetimevalue"],
  points: ["loyaltypoints", "points", "rewardpoints"],
  disabled: ["disabledinquickvee", "disabled", "inactive"]
} as const;
type Field = keyof typeof COLUMNS;

/** Phone key for dedupe: last 10 digits (matches the Quickvee sync's matching rule). */
export const phoneKey = (p: string | null | undefined) => (p ? p.replace(/\D/g, "").slice(-10) || null : null);
export const emailKey = (e: string | null | undefined) => (e ? e.trim().toLowerCase() || null : null);

function ageFrom(dobIso: string | null, now = Date.now()): number | null {
  if (!dobIso) return null;
  const d = new Date(dobIso), n = new Date(now);
  let a = n.getUTCFullYear() - d.getUTCFullYear();
  if (n.getUTCMonth() < d.getUTCMonth() || (n.getUTCMonth() === d.getUTCMonth() && n.getUTCDate() < d.getUTCDate())) a--;
  return a >= 0 && a <= 130 ? a : null;
}

/** Parses and validates a customer CSV. Never throws on bad rows: they come back in `invalid` with a reason. */
export function parseCustomerCsv(text: string, opts: { tz?: string; now?: number } = {}): ParsedImport {
  let raw: Record<string, string>[];
  try { raw = parseCsv(text); } catch (e) {
    throw new ImportError(`Couldn't read the CSV: ${e instanceof Error ? e.message.split("\n")[0] : "invalid format"}`);
  }
  if (!raw.length) throw new ImportError("The CSV has no data rows.");
  if (raw.length > MAX_IMPORT_ROWS) throw new ImportError(`Too many rows (${raw.length}); the limit is ${MAX_IMPORT_ROWS} per upload.`);
  const headers = new Map(Object.keys(raw[0]).map(h => [k(h), h]));
  const col: Partial<Record<Field, string>> = {};
  for (const [f, aliases] of Object.entries(COLUMNS) as [Field, readonly string[]][]) {
    const hit = aliases.find(a => headers.has(a));
    if (hit) col[f] = headers.get(hit)!;
  }
  if (!col.phone && !col.email) throw new ImportError("The CSV needs a Phone or Email column.");
  if (!col.firstName && !col.name) throw new ImportError("The CSV needs a First name or Name column.");

  const customers: ImportCustomer[] = [], invalid: InvalidRow[] = [];
  const seen = { ids: new Set<string>(), phones: new Set<string>(), emails: new Set<string>() };
  let duplicatesInFile = 0;
  raw.forEach((r, i) => {
    const row = i + 1;
    const get = (f: Field) => (col[f] ? String(r[col[f]!] ?? "").trim() : "");
    if (/^(yes|true|1|y)$/i.test(get("disabled"))) { invalid.push({ row, reason: "Disabled in POS" }); return; }
    // "First name" sometimes holds the full name (Quickvee): split it when there's no last name.
    let first = get("firstName"), last = get("lastName");
    if (!first) first = get("name");
    if (first && !last && /\s/.test(first)) { const [a, b] = splitName(first); first = a ?? ""; last = b ?? ""; }
    const rawPhone = get("phone"), rawEmail = get("email");
    const phone = normalizePhone(rawPhone), email = normalizeEmail(rawEmail);
    if (!first) { invalid.push({ row, reason: "Missing name" }); return; }
    if (!phone && !email) {
      invalid.push({ row, reason: rawPhone || rawEmail ? "Invalid phone and email" : "No phone or email" });
      return;
    }
    const externalId = get("id") || null;
    const pk = phoneKey(phone), ek = emailKey(email);
    if ((externalId && seen.ids.has(externalId)) || (pk && seen.phones.has(pk)) || (ek && seen.emails.has(ek))) { duplicatesInFile++; return; }
    if (externalId) seen.ids.add(externalId);
    if (pk) seen.phones.add(pk);
    if (ek) seen.emails.add(ek);
    const points = get("points") ? Math.round(Number(get("points").replace(/[^0-9.]/g, ""))) : null;
    const place = get("store") || [get("city"), get("state")].filter(Boolean).join(", ");
    customers.push({
      row, externalId, firstName: first.slice(0, 100), lastName: last.slice(0, 100), phone, email,
      location: place ? place.slice(0, 200) : null,
      age: ageFrom(toIso(get("dob") || undefined, opts.tz), opts.now),
      lastPurchaseAt: toIso(get("lastOrder") || undefined, opts.tz),
      lifetimeSpendCents: Math.max(0, toCents(get("spend"))),
      rewardsPoints: points !== null && Number.isFinite(points) && points >= 0 ? points : null,
      customerSince: toIso(get("since") || undefined, opts.tz)?.slice(0, 10) ?? null
    });
  });
  return { customers, invalid, duplicatesInFile };
}

export const isExisting = (c: Pick<ImportCustomer, "externalId" | "phone" | "email">, keys: ExistingKeys) =>
  (c.externalId !== null && keys.externalIds.has(`qv:${c.externalId}`)) ||
  (phoneKey(c.phone) !== null && keys.phones.has(phoneKey(c.phone)!)) ||
  (emailKey(c.email) !== null && keys.emails.has(emailKey(c.email)!));

/** What the confirm popup shows: masked contact details only. */
export const toPreview = (c: ImportCustomer) => ({
  row: c.row, name: `${c.firstName} ${c.lastName}`.trim(), phone: c.phone ? maskRecipient(c.phone) : null, email: c.email ? maskRecipient(c.email) : null,
  location: c.location, lifetimeSpendCents: c.lifetimeSpendCents, lastPurchaseAt: c.lastPurchaseAt
});

export class ImportError extends Error { constructor(message: string) { super(message); this.name = "ImportError"; } }
