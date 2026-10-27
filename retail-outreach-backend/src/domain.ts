import type { Channel, Customer, Opportunity } from "./types.js";

const DAY_MS = 86_400_000;

export function daysSince(iso: string | null, now = Date.now()): number | null {
  if (!iso) return null;
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / DAY_MS));
}

/** Very small E.164-ish check; real validation should come from your SMS provider's lookup API. */
export function isValidPhone(phone: string | null): boolean {
  return Boolean(phone && /^\+?[1-9]\d{9,14}$/.test(phone.replace(/[\s().-]/g, "")));
}

export function isValidEmail(email: string | null): boolean {
  return Boolean(email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
}

export function canContact(customer: Customer, channel: Channel): boolean {
  if (customer.suppressed.includes(channel)) return false;
  return channel === "sms"
    ? customer.smsConsent && isValidPhone(customer.phone)
    : customer.emailConsent && isValidEmail(customer.email);
}

export function preferredChannel(customer: Customer): Channel | null {
  return canContact(customer, "sms") ? "sms" : canContact(customer, "email") ? "email" : null;
}

export function recipientFor(customer: Customer, channel: Channel): string | null {
  return channel === "sms" ? customer.phone : customer.email;
}

/** Canonical contact value for suppression matching. Mirrors public.normalize_contact() in SQL. */
export function normalizeContact(channel: Channel, value: string | null): string | null {
  if (!value) return null;
  if (channel === "sms") {
    const digits = value.replace(/\D/g, "");
    return digits ? `+${digits}` : null;
  }
  return value.trim().toLowerCase() || null;
}

/** "+15555550001" -> "+15***01", "sarah@example.com" -> "sa***@example.com". Safe for logs and API responses. */
export function maskRecipient(value: string): string {
  const at = value.indexOf("@");
  if (at > 0) return `${value.slice(0, Math.min(2, at))}***${value.slice(at)}`;
  return value.length <= 5 ? "***" : `${value.slice(0, 3)}***${value.slice(-2)}`;
}

export const ACTIONABLE_STATUSES = ["pending", "drafted"] as const;

/** Shape returned to the browser. No raw phone/email. */
export function toCardDto(opp: Opportunity, now = Date.now()) {
  const c = opp.customer;
  const [last, ...earlier] = c.purchases;
  return {
    id: opp.id,
    status: opp.status,
    campaign: opp.campaign,
    rationale: opp.rationale,
    offer: opp.offer,
    customer: {
      id: c.id,
      displayName: `${c.firstName} ${c.lastName ? `${c.lastName[0]}.` : ""}`.trim(),
      firstName: c.firstName,
      age: c.age,
      gender: c.gender,
      location: c.location,
      storesShopped: c.storesShopped,
      lifetimeSpendCents: c.lifetimeSpendCents,
      daysSinceLastPurchase: daysSince(c.lastPurchaseAt, now),
      itemsPurchased: c.itemsPurchased,
      contact: {
        sms: canContact(c, "sms"),
        email: canContact(c, "email"),
        preferredChannel: preferredChannel(c)
      }
    },
    lastPurchase: last ? {
      name: last.name,
      category: last.category,
      priceCents: last.priceCents,
      imageUrl: last.imageUrl,
      daysAgo: daysSince(last.purchasedAt, now),
      alsoPurchased: [...new Set(earlier.map(p => p.name))].filter(n => n !== last.name).slice(0, 3)
    } : null
  };
}

export type CardDto = ReturnType<typeof toCardDto>;

export function humanizeDays(days: number | null): string {
  if (days === null) return "a while";
  if (days >= 365) return `over ${days >= 730 ? "two years" : "a year"}`;
  if (days >= 60) return `over ${["", "", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"][Math.floor(days / 30)]} months`;
  if (days >= 30) return "over a month";
  if (days >= 14) return `over ${Math.floor(days / 7) === 2 ? "two" : "three"} weeks`;
  return `${days} days`;
}
