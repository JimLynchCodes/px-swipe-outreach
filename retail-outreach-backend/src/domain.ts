import type { Channel, Customer, DealInput, Opportunity, Segment } from "./types.js";

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

export const MIN_AGE = 21;
/** Age-restricted retail: only market to customers whose ID was checked and who are 21+. */
export function isAgeEligible(customer: Pick<Customer, "age" | "ageVerified">): boolean {
  return customer.ageVerified && customer.age !== null && customer.age >= MIN_AGE;
}

export function canContact(customer: Customer, channel: Channel): boolean {
  if (customer.suppressed.includes(channel)) return false;
  if (!isAgeEligible(customer)) return false;
  return channel === "sms"
    ? customer.smsConsent && isValidPhone(customer.phone)
    : customer.emailConsent && isValidEmail(customer.email);
}

/** Per-channel cooldown windows in days (0 = off). */
export type CooldownDays = { sms: number; email: number };
export const NO_COOLDOWN: CooldownDays = { sms: 0, email: 0 };

export function lastSentAt(customer: Customer, channel: Channel): string | null {
  return (channel === "sms" ? customer.lastSmsAt : customer.lastEmailAt) ?? null;
}

/** When the channel's cooldown ends (ISO), or null when the customer can be reached on it now. */
export function cooldownUntil(customer: Customer, channel: Channel, cooldown: CooldownDays, now = Date.now()): string | null {
  const days = cooldown[channel];
  const last = lastSentAt(customer, channel);
  if (!days || days <= 0 || !last) return null;
  const until = new Date(last).getTime() + days * DAY_MS;
  return until > now ? new Date(until).toISOString() : null;
}

/** Contactable on this channel and outside its cooldown window. */
export function canReachNow(customer: Customer, channel: Channel, cooldown: CooldownDays, now = Date.now()): boolean {
  return canContact(customer, channel) && !cooldownUntil(customer, channel, cooldown, now);
}

/**
 * Deck filter: a customer stays in the deck unless cooldown is the reason they can't be reached, i.e. at least one
 * channel is cooling down and no channel is both contactable and outside its window.
 */
export function inDeck(customer: Customer, cooldown: CooldownDays, now = Date.now()): boolean {
  const cooling = (["sms", "email"] as const).some(ch => cooldownUntil(customer, ch, cooldown, now));
  if (!cooling) return true;
  return canReachNow(customer, "sms", cooldown, now) || canReachNow(customer, "email", cooldown, now);
}

export function preferredChannel(customer: Customer, cooldown: CooldownDays = NO_COOLDOWN, now = Date.now()): Channel | null {
  return canReachNow(customer, "sms", cooldown, now) ? "sms" : canReachNow(customer, "email", cooldown, now) ? "email" : null;
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

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
/** JS getDay() (0 = Sunday) → our 0 = Monday convention. */
export const weekdayOf = (d: Date) => (d.getDay() + 6) % 7;

/** loyal / at_risk / lapsed, judged against the customer's own visit rhythm. */
export function segmentOf(customer: Customer, now = Date.now()): Segment {
  const days = daysSince(customer.lastPurchaseAt, now);
  if (days === null) return "lapsed";
  const interval = 30 / Math.max(0.1, customer.profile.visitsPerMonth || 0.1);
  if (days >= Math.max(60, interval * 3)) return "lapsed";
  if (days >= Math.max(21, interval * 1.75)) return "at_risk";
  return "loyal";
}

const money0 = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
export function discountLabel(d: Pick<DealInput, "discountType" | "discountValue">): string {
  switch (d.discountType) {
    case "percent": return `${d.discountValue ?? 0}% off`;
    case "amount": return `${money0(d.discountValue ?? 0)} off`;
    case "bogo": return "Buy one, get one";
    case "freebie": return "Free gift";
  }
}

export const SMS_OPT_OUT = "Reply STOP to opt out.";
export const SMS_MAX = 480; // ~3 SMS segments
/** Every marketing SMS must carry opt-out instructions. Appends them when the text doesn't already have them. */
export function withSmsOptOut(message: string): string {
  const m = message.trim();
  return /\bstop\b/i.test(m) && /opt[ -]?out|unsubscribe/i.test(m) ? m : `${m}\n${SMS_OPT_OUT}`;
}
export const EMAIL_FOOTER = "You're receiving this because you opted in to offers from us. Must be 21+ to purchase. Use the unsubscribe link below to stop these emails.";
export function withEmailFooter(message: string): string {
  const m = message.trim();
  return /unsubscribe/i.test(m) ? m : `${m}\n\n${EMAIL_FOOTER}`;
}

export const ACTIONABLE_STATUSES = ["pending", "drafted"] as const;

/** Shape returned to the browser. No raw phone/email. */
export function toCardDto(opp: Opportunity, now = Date.now(), cooldown: CooldownDays = NO_COOLDOWN, opts: { bypassCooldown?: boolean } = {}) {
  const c = opp.customer;
  /** An explicit pick (Registered users) may contact inside the window; the card still reports the window so it can warn. */
  const reach = opts.bypassCooldown ? NO_COOLDOWN : cooldown;
  const [last, ...earlier] = c.purchases;
  return {
    id: opp.id,
    status: opp.status,
    campaign: opp.campaign,
    rationale: opp.rationale,
    segment: segmentOf(c, now),
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
      ageVerified: isAgeEligible(c),
      profile: c.profile,
      contact: {
        sms: canReachNow(c, "sms", reach, now),
        email: canReachNow(c, "email", reach, now),
        preferredChannel: preferredChannel(c, reach, now),
        /** Last outreach send from this app per channel (ISO or null) and when each channel's cooldown ends (null = not cooling down). */
        lastSent: { sms: c.lastSmsAt ?? null, email: c.lastEmailAt ?? null },
        cooldownUntil: { sms: cooldownUntil(c, "sms", cooldown, now), email: cooldownUntil(c, "email", cooldown, now) },
        blockedReason: !isAgeEligible(c) ? "age_unverified" as const
          : c.suppressed.length === 2 ? "opted_out" as const : null
      }
    },
    recentItems: c.purchases.slice(0, 5).map(p => ({ name: p.name, brand: p.brand, category: p.category, daysAgo: daysSince(p.purchasedAt, now) })),
    lastPurchase: last ? {
      name: last.name,
      category: last.category,
      brand: last.brand,
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
