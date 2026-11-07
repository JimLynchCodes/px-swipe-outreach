/**
 * Demo dataset for "Cloud 9 Smoke Shop", shared by the in-memory store and the Postgres seed script.
 * Every customer is an age-verified adult (21+) unless noted. Dates are relative to "now" so the demo stays fresh.
 */
import type { DealInput, PreferredTime } from "../types.js";

/** Fixed identifiers for the demo organization and its owner (used by demo auth and the seed script). */
export const DEMO_ORG_ID = "00000000-0000-4000-8000-000000000101";
export const DEMO_SETTINGS = {
  storeName: "Cloud 9 Smoke Shop",
  emailSignature: "Cloud 9 Smoke Shop\n123 Main St · Open daily 10am–10pm\n21+ with valid ID",
  smsSignature: "-Cloud 9",
  defaultChannel: null,
  maxDiscountPercent: 25
} as const;
export const DEMO_ORG = { id: DEMO_ORG_ID, name: "Cloud 9 Smoke Shop", slug: "demo-retailer", businessName: "Cloud 9 Smoke Shop" };
export const DEMO_USER_ID = "00000000-0000-4000-8000-000000000001";
export const DEMO_USER_EMAIL = "demo@px-outreach.local";

export const CATEGORIES = ["vape", "cbd", "glass", "papers", "cigars", "hookah", "accessories"] as const;
export type Category = (typeof CATEGORIES)[number];

export type SeedProduct = { id: string; name: string; brand: string; category: Category; priceCents: number; imageUrl: string | null };
export type SeedCustomer = {
  id: string; firstName: string; lastName: string; age: number | null; gender: string | null; location: string;
  storesShopped: string[]; phone: string | null; email: string | null;
  smsConsent: boolean; emailConsent: boolean; ageVerified: boolean;
  /** [productId, daysAgo] most recent first */
  purchases: Array<[string, number]>;
  /** Extra historical spend not represented by the line items above. */
  extraSpendCents: number;
  profile: {
    favoriteCategories: Category[]; favoriteBrands: string[];
    visitsPerMonth: number; avgBasketCents: number;
    /** 0 = Monday … 6 = Sunday */
    preferredDay: number; preferredTime: PreferredTime;
  };
};

export const products: SeedProduct[] = [
  { id: "prod_geekbar", name: "Geek Bar Pulse 15K", brand: "Geek Bar", category: "vape", priceCents: 2200, imageUrl: null },
  { id: "prod_elfbar", name: "Elf Bar BC5000", brand: "Elf Bar", category: "vape", priceCents: 2000, imageUrl: null },
  { id: "prod_nord", name: "SMOK Nord 5 Kit", brand: "SMOK", category: "vape", priceCents: 4500, imageUrl: null },
  { id: "prod_naked", name: "Naked 100 Salt 30ml", brand: "Naked 100", category: "vape", priceCents: 1800, imageUrl: null },
  { id: "prod_cwoil", name: "Charlotte's Web CBD Oil 1500mg", brand: "Charlotte's Web", category: "cbd", priceCents: 8999, imageUrl: null },
  { id: "prod_cornbread", name: "Cornbread Hemp Gummies 30ct", brand: "Cornbread Hemp", category: "cbd", priceCents: 4500, imageUrl: null },
  { id: "prod_koi", name: "Koi CBD Gummies 20ct", brand: "Koi", category: "cbd", priceCents: 3500, imageUrl: null },
  { id: "prod_beaker", name: "GRAV 10\" Beaker", brand: "GRAV", category: "glass", priceCents: 8500, imageUrl: null },
  { id: "prod_spoon", name: "GRAV Spoon Pipe", brand: "GRAV", category: "glass", priceCents: 2500, imageUrl: null },
  { id: "prod_rig", name: "Empire Glassworks Mini Rig", brand: "Empire Glassworks", category: "glass", priceCents: 12000, imageUrl: null },
  { id: "prod_raw", name: "RAW Classic King Size", brand: "RAW", category: "papers", priceCents: 400, imageUrl: null },
  { id: "prod_zigzag", name: "Zig-Zag Ultra Thin", brand: "Zig-Zag", category: "papers", priceCents: 300, imageUrl: null },
  { id: "prod_cones", name: "RAW Organic Hemp Cones 6pk", brand: "RAW", category: "papers", priceCents: 600, imageUrl: null },
  { id: "prod_fuente", name: "Arturo Fuente Gran Reserva", brand: "Arturo Fuente", category: "cigars", priceCents: 900, imageUrl: null },
  { id: "prod_padron", name: "Padrón 1964 Anniversary", brand: "Padrón", category: "cigars", priceCents: 2500, imageUrl: null },
  { id: "prod_oliva", name: "Oliva Serie V", brand: "Oliva", category: "cigars", priceCents: 1200, imageUrl: null },
  { id: "prod_alfakher", name: "Al Fakher Double Apple 250g", brand: "Al Fakher", category: "hookah", priceCents: 2200, imageUrl: null },
  { id: "prod_khalil", name: "Khalil Mamoon Hookah", brand: "Khalil Mamoon", category: "hookah", priceCents: 9500, imageUrl: null },
  { id: "prod_coconara", name: "Coco Nara Coals 72pc", brand: "Coco Nara", category: "hookah", priceCents: 1200, imageUrl: null },
  { id: "prod_fumari", name: "Fumari White Gummi Bear 100g", brand: "Fumari", category: "hookah", priceCents: 1400, imageUrl: null },
  { id: "prod_grinder", name: "Santa Cruz Shredder 4pc", brand: "Santa Cruz Shredder", category: "accessories", priceCents: 7500, imageUrl: null },
  { id: "prod_clipper", name: "Clipper Lighter 4pk", brand: "Clipper", category: "accessories", priceCents: 800, imageUrl: null },
  { id: "prod_tray", name: "RAW Rolling Tray", brand: "RAW", category: "accessories", priceCents: 2000, imageUrl: null },
  { id: "prod_cleaner", name: "Formula 420 Cleaner", brand: "Formula 420", category: "accessories", priceCents: 1200, imageUrl: null }
];

type Opts = Partial<Pick<SeedCustomer, "phone" | "email" | "smsConsent" | "emailConsent" | "extraSpendCents" | "ageVerified" | "gender">>;
const c = (
  id: string, firstName: string, lastName: string, age: number | null, location: string, storesShopped: string[],
  purchases: Array<[string, number]>, profile: SeedCustomer["profile"], opts: Opts = {}
): SeedCustomer => ({
  id, firstName, lastName, age, gender: opts.gender ?? null, location, storesShopped, purchases, profile,
  phone: opts.phone === undefined ? `+1555555${id.slice(-4).padStart(4, "0")}` : opts.phone,
  email: opts.email === undefined ? `${firstName.toLowerCase()}@example.com` : opts.email,
  smsConsent: opts.smsConsent ?? true,
  emailConsent: opts.emailConsent ?? true,
  ageVerified: opts.ageVerified ?? true,
  extraSpendCents: opts.extraSpendCents ?? 0
});
const p = (favoriteCategories: Category[], favoriteBrands: string[], visitsPerMonth: number, avgBasketCents: number,
  preferredDay: number, preferredTime: PreferredTime): SeedCustomer["profile"] =>
  ({ favoriteCategories, favoriteBrands, visitsPerMonth, avgBasketCents, preferredDay, preferredTime });

const MON = 0, TUE = 1, WED = 2, THU = 3, FRI = 4, SAT = 5, SUN = 6;

export const customers: SeedCustomer[] = [
  c("cust_0001", "Sarah", "Mitchell", 34, "Main St", ["Main St", "Eastside"],
    [["prod_cwoil", 58], ["prod_cornbread", 58], ["prod_koi", 95]], p(["cbd"], ["Charlotte's Web", "Cornbread Hemp"], 1, 9800, MON, "evening"), { extraSpendCents: 41000 }),
  c("cust_0002", "Jamal", "Carter", 41, "Eastside", ["Eastside"],
    [["prod_padron", 9], ["prod_oliva", 9], ["prod_fuente", 23]], p(["cigars"], ["Padrón", "Oliva"], 3, 5400, FRI, "evening"), { extraSpendCents: 128000 }),
  c("cust_0003", "Priya", "Shah", 26, "Campus", ["Campus"],
    [["prod_geekbar", 4], ["prod_geekbar", 11], ["prod_elfbar", 19]], p(["vape"], ["Geek Bar", "Elf Bar"], 4, 2400, THU, "afternoon")),
  c("cust_0004", "Marcus", "Lee", 52, "Main St", ["Main St"],
    [["prod_padron", 74], ["prod_fuente", 74], ["prod_clipper", 120]], p(["cigars", "accessories"], ["Padrón", "Arturo Fuente"], 2, 6200, SAT, "afternoon"), { extraSpendCents: 86000 }),
  c("cust_0005", "Elena", "Garcia", 37, "Eastside", ["Eastside"],
    [["prod_alfakher", 33], ["prod_coconara", 33]], p(["hookah"], ["Al Fakher", "Coco Nara"], 1.5, 3800, SAT, "evening"), { phone: null, smsConsent: false }),
  c("cust_0006", "Tyler", "Nguyen", 23, "Campus", ["Campus", "Main St"],
    [["prod_raw", 6], ["prod_cones", 6], ["prod_clipper", 13]], p(["papers", "accessories"], ["RAW", "Clipper"], 5, 1400, TUE, "evening")),
  c("cust_0007", "Dana", "Brooks", 45, "Main St", ["Main St"],
    [["prod_beaker", 140], ["prod_cleaner", 140]], p(["glass", "accessories"], ["GRAV", "Formula 420"], 0.7, 9700, WED, "afternoon"), { extraSpendCents: 31000 }),
  c("cust_0008", "Chris", "Ortiz", 29, "Eastside", ["Eastside", "Campus"],
    [["prod_nord", 21], ["prod_naked", 21], ["prod_naked", 40]], p(["vape"], ["SMOK", "Naked 100"], 2, 3600, THU, "evening")),
  c("cust_0009", "Hannah", "Wright", 58, "Main St", ["Main St"],
    [["prod_cwoil", 12], ["prod_koi", 40]], p(["cbd"], ["Charlotte's Web", "Koi"], 1.5, 8200, MON, "morning"), { extraSpendCents: 104000 }),
  c("cust_0010", "Luis", "Romero", 39, "Eastside", ["Eastside"],
    [["prod_khalil", 88], ["prod_fumari", 88], ["prod_coconara", 120]], p(["hookah"], ["Khalil Mamoon", "Fumari"], 1, 6500, SAT, "evening")),
  c("cust_0011", "Grace", "Okafor", 24, "Campus", ["Campus"],
    [["prod_spoon", 17], ["prod_grinder", 17], ["prod_zigzag", 30]], p(["glass", "papers"], ["GRAV", "Zig-Zag"], 2, 4200, FRI, "evening")),
  c("cust_0012", "Ben", "Fischer", 47, "Main St", ["Main St", "Eastside"],
    [["prod_oliva", 210], ["prod_fuente", 260]], p(["cigars"], ["Oliva", "Arturo Fuente"], 1, 3300, FRI, "evening"), { extraSpendCents: 22000 }),
  c("cust_0013", "Mia", "Rossi", 33, "Eastside", ["Eastside", "Main St"],
    [["prod_rig", 26], ["prod_cleaner", 26], ["prod_tray", 60]], p(["glass", "accessories"], ["Empire Glassworks", "RAW"], 1, 7800, WED, "evening")),
  c("cust_0014", "Owen", "Patel", 28, "Campus", ["Campus"],
    [["prod_elfbar", 16], ["prod_geekbar", 30]], p(["vape"], ["Elf Bar", "Geek Bar"], 3, 2100, THU, "evening"), { email: null, emailConsent: false }),
  c("cust_0015", "Chloe", "Dubois", 36, "Main St", ["Main St"],
    [["prod_cornbread", 45], ["prod_raw", 45]], p(["cbd", "papers"], ["Cornbread Hemp", "RAW"], 1, 4900, SUN, "afternoon")),
  c("cust_0016", "Noah", "Andersen", 44, "Eastside", ["Eastside"],
    [["prod_grinder", 98], ["prod_beaker", 160]], p(["glass", "accessories"], ["Santa Cruz Shredder", "GRAV"], 0.5, 8000, SAT, "afternoon"), { extraSpendCents: 54000 }),
  c("cust_0017", "Zoe", "Martin", 27, "Campus", ["Campus", "Eastside"],
    [["prod_alfakher", 8], ["prod_fumari", 8], ["prod_coconara", 22]], p(["hookah"], ["Al Fakher", "Fumari"], 2.5, 4600, SAT, "evening")),
  c("cust_0018", "Ethan", "Brooks", 50, "Main St", ["Main St"],
    [["prod_fuente", 3], ["prod_padron", 10], ["prod_oliva", 17]], p(["cigars"], ["Arturo Fuente", "Padrón"], 4, 4100, FRI, "afternoon"), { extraSpendCents: 165000 }),
  c("cust_0019", "Lily", "Chen", 31, "Eastside", ["Eastside", "Campus"],
    [["prod_naked", 64], ["prod_nord", 130]], p(["vape"], ["Naked 100", "SMOK"], 1.5, 2900, SUN, "afternoon"), { smsConsent: false }),
  c("cust_0020", "Ryan", "Walsh", null, "Main St", ["Main St"],
    [["prod_raw", 15], ["prod_tray", 15]], p(["papers", "accessories"], ["RAW"], 2, 2400, TUE, "evening"), { ageVerified: false })
];

export const campaigns = [
  { id: "winback", type: "win_back", name: "Win-back" },
  { id: "retain", type: "nurture", name: "At-risk check-in" },
  { id: "vip", type: "vip_thanks", name: "VIP appreciation" },
  { id: "restock", type: "nurture", name: "Restock reminder" }
] as const;

/** Fallback offers used when no daily deal fits the customer. */
export const offers = [
  { id: "WINBACK15", name: "Come-back 15%", discountPercent: 15, combinable: false },
  { id: "CHECKIN10", name: "Check-in 10%", discountPercent: 10, combinable: true },
  { id: "VIP20", name: "VIP 20%", discountPercent: 20, combinable: false }
];

/** Example promotions (days: 0 = Monday). Disabled ones are kept for reuse but ignored by the engine. Age-restricted items: offers are only ever sent to verified 21+ customers. */
export const weeklyDeals: DealInput[] = [
  { schedule: "weekly", days: [MON, TUE, WED, THU, FRI, SAT, SUN], title: "Holiday Glass Sale", description: "25% off all glass through New Year's.", discountType: "percent", discountValue: 25, categories: ["glass"], productIds: [], startsOn: null, endsOn: null, active: false },
  { schedule: "weekly", days: [MON], title: "Mellow Monday", description: "15% off all CBD oils and gummies.", discountType: "percent", discountValue: 15, categories: ["cbd"], productIds: [], startsOn: null, endsOn: null, active: true },
  { schedule: "weekly", days: [TUE], title: "Two-for Tuesday", description: "Buy one pack of papers or cones, get one free.", discountType: "bogo", discountValue: null, categories: ["papers"], productIds: [], startsOn: null, endsOn: null, active: true },
  { schedule: "weekly", days: [WED], title: "Glass Hump Day", description: "$15 off any glass piece over $60.", discountType: "amount", discountValue: 1500, categories: ["glass"], productIds: [], startsOn: null, endsOn: null, active: true },
  { schedule: "weekly", days: [WED], title: "Cleaner bundle", description: "Free Formula 420 cleaner with any glass purchase.", discountType: "freebie", discountValue: null, categories: ["glass"], productIds: ["prod_cleaner"], startsOn: null, endsOn: null, active: true },
  { schedule: "weekly", days: [THU], title: "Throwback Thursday", description: "10% off Geek Bar and Elf Bar disposables.", discountType: "percent", discountValue: 10, categories: ["vape"], productIds: ["prod_geekbar", "prod_elfbar"], startsOn: null, endsOn: null, active: true },
  { schedule: "weekly", days: [FRI], title: "Cigar Friday", description: "20% off premium singles — Padrón, Fuente, Oliva.", discountType: "percent", discountValue: 20, categories: ["cigars"], productIds: [], startsOn: null, endsOn: null, active: true },
  { schedule: "weekly", days: [SAT], title: "Hookah Night Saturday", description: "15% off hookahs and shisha, free coals over $40.", discountType: "percent", discountValue: 15, categories: ["hookah"], productIds: [], startsOn: null, endsOn: null, active: true },
  { schedule: "weekly", days: [SAT], title: "Grinder upgrade", description: "$10 off Santa Cruz Shredder grinders.", discountType: "amount", discountValue: 1000, categories: ["accessories"], productIds: ["prod_grinder"], startsOn: null, endsOn: null, active: true },
  { schedule: "weekly", days: [SAT, SUN], title: "Weekend Restock", description: "10% off accessories and rolling supplies.", discountType: "percent", discountValue: 10, categories: ["accessories", "papers"], productIds: [], startsOn: null, endsOn: null, active: true }
];

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const ALL = [MON, TUE, WED, THU, FRI, SAT, SUN];

/**
 * Seasonal & ongoing promotions (schedule "range": every day from startsOn to endsOn), dated relative to `now`
 * so the demo always has one running, one about to start and one further out.
 */
export function seasonalDeals(now = new Date()): DealInput[] {
  const today = ymd(now);
  const y = ymd(new Date(now.getFullYear(), 11, 31)) >= today ? now.getFullYear() : now.getFullYear() + 1;
  // Black Friday = day after the 4th Thursday of November; promo runs Fri–Sun.
  const nov1 = new Date(y, 10, 1);
  const thanksgiving = 1 + ((4 - nov1.getDay() + 7) % 7) + 21;
  const bf = new Date(y, 10, thanksgiving + 1);
  const bfEnd = new Date(y, 10, thanksgiving + 3);
  const y420 = ymd(new Date(now.getFullYear(), 3, 22)) >= today ? now.getFullYear() : now.getFullYear() + 1;
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const monthName = monthStart.toLocaleString("en-US", { month: "long" });
  const range = (title: string, description: string, startsOn: string, endsOn: string, rest: Partial<DealInput>): DealInput => ({
    schedule: "range", days: ALL, title, description, discountType: "percent", discountValue: 10, categories: [], productIds: [],
    startsOn, endsOn, active: true, ...rest
  });
  return [
    range("Holiday Season Glass", "20% off glass and grinders, gift-ready, all season.", `${y}-11-20`, `${y}-12-31`,
      { discountValue: 20, categories: ["glass", "accessories"] }),
    range("Black Friday Weekend", "25% off premium cigars and hookahs, Friday to Sunday.", ymd(bf), ymd(bfEnd),
      { discountValue: 25, categories: ["cigars", "hookah"] }),
    range("4/20 Week", "Buy one, get one on papers and cones all week.", `${y420}-04-16`, `${y420}-04-22`,
      { discountType: "bogo", discountValue: null, categories: ["papers"] }),
    range(`${monthName} Vape Special`, `10% off disposables all ${monthName}.`, ymd(monthStart), ymd(monthEnd),
      { discountValue: 10, categories: ["vape"], active: false })
  ];
}

/** Example promotions (days: 0 = Monday): the weekly slots plus seasonal date ranges. */
export const deals: DealInput[] = [...weeklyDeals, ...seasonalDeals()];

export function productById(id: string): SeedProduct {
  const prod = products.find(x => x.id === id);
  if (!prod) throw new Error(`Unknown seed product ${id}`);
  return prod;
}

export function lifetimeSpend(customer: SeedCustomer): number {
  return customer.purchases.reduce((sum, [pid]) => sum + productById(pid).priceCents, 0) + customer.extraSpendCents;
}

/** Targeting by segment (see segmentOf), mirrored by the Postgres seed. */
export function chooseCampaign(segment: "loyal" | "at_risk" | "lapsed", lifetimeSpendCents: number, daysSinceLast: number) {
  if (segment === "lapsed") return { campaignId: "winback", offerId: "WINBACK15", score: 85, rationale: `Lapsed: no visit in ${daysSinceLast} days` };
  if (segment === "at_risk") return { campaignId: "retain", offerId: "CHECKIN10", score: 80, rationale: `Visits slipping: ${daysSinceLast} days since last visit` };
  if (lifetimeSpendCents >= 100_000) return { campaignId: "vip", offerId: "VIP20", score: 75, rationale: "Top spender; keep them loyal" };
  return { campaignId: "restock", offerId: null, score: 60, rationale: "Regular; time the next visit around a deal" };
}

/** Demo reply threads (minutesAgo: oldest first). `read: false` leaves the inbound tail unread. */
export type SeedThread = {
  customerId: string; channel: "sms" | "email"; read: boolean;
  messages: Array<{ direction: "inbound" | "outbound"; minutesAgo: number; body: string; subject?: string; kind?: "message" | "opt_out" | "auto" }>;
};
export const threads: SeedThread[] = [
  { customerId: "cust_0002", channel: "sms", read: false, messages: [
    { direction: "outbound", minutesAgo: 60 * 26, body: "Hi Jamal, it's Cloud 9 Smoke Shop! Friday only: Cigar Friday. 20% off premium singles — Padrón, Fuente, Oliva. 21+ w/ ID. -Cloud 9\nReply STOP to opt out." },
    { direction: "inbound", minutesAgo: 42, body: "Nice. You guys have the Padrón 1926 No. 9 in? Want to grab a few Friday" }
  ] },
  { customerId: "cust_0003", channel: "sms", read: false, messages: [
    { direction: "outbound", minutesAgo: 60 * 50, body: "Hi Priya, it's Cloud 9 Smoke Shop! Thursday only: Throwback Thursday. 10% off Geek Bar and Elf Bar disposables. 21+ w/ ID. -Cloud 9\nReply STOP to opt out." },
    { direction: "inbound", minutesAgo: 60 * 3, body: "is that on all the pulse flavors?? need blue razz ice" },
    { direction: "inbound", minutesAgo: 60 * 3 - 1, body: "and can I hold 2" }
  ] },
  { customerId: "cust_0001", channel: "email", read: true, messages: [
    { direction: "outbound", minutesAgo: 60 * 24 * 3, subject: "Mellow Monday this Monday, Sarah", body: "Hi Sarah,\n\nMonday only: Mellow Monday. 15% off all CBD oils and gummies. 21+ w/ ID.\n\nSee you soon,\nCloud 9 Smoke Shop" },
    { direction: "inbound", minutesAgo: 60 * 24 * 2, subject: "Re: Mellow Monday this Monday, Sarah", body: "Thanks! Does the 15% include the Charlotte's Web 3000mg?" },
    { direction: "outbound", minutesAgo: 60 * 24 * 2 - 30, subject: "Re: Mellow Monday this Monday, Sarah", body: "It does! We have two bottles on the shelf right now.\n\nCloud 9 Smoke Shop" }
  ] },
  { customerId: "cust_0005", channel: "email", read: false, messages: [
    { direction: "inbound", minutesAgo: 60 * 7, subject: "Hookah night", body: "Hey, are you getting more of the Al Fakher mint 1kg tubs? Last time you were sold out." }
  ] },
  { customerId: "cust_0017", channel: "sms", read: true, messages: [
    { direction: "outbound", minutesAgo: 60 * 24 * 6, body: "Hi Zoe, it's Cloud 9 Smoke Shop! Saturday only: Hookah Night Saturday. 15% off hookahs and shisha, free coals over $40. 21+ w/ ID. -Cloud 9\nReply STOP to opt out." },
    { direction: "inbound", minutesAgo: 60 * 24 * 5, body: "omw saturday 🙌" }
  ] },
  { customerId: "cust_0008", channel: "sms", read: false, messages: [
    { direction: "outbound", minutesAgo: 60 * 24 * 4, body: "Hi Chris, it's Cloud 9 Smoke Shop! Thursday only: Throwback Thursday. 10% off disposables. 21+ w/ ID. -Cloud 9\nReply STOP to opt out." },
    { direction: "inbound", minutesAgo: 60 * 20, body: "STOP", kind: "opt_out" },
    { direction: "outbound", minutesAgo: 60 * 20, body: "Cloud 9 Smoke Shop: You have been unsubscribed and will not receive any more messages. Reply START to resubscribe.", kind: "auto" }
  ] }
];

/** Demo opt-outs (per channel). */
export const optOuts: Array<{ customerId: string; channel: "sms" | "email"; source: "sms_stop" | "email_unsubscribe" | "manual"; minutesAgo: number }> = [
  { customerId: "cust_0008", channel: "sms", source: "sms_stop", minutesAgo: 60 * 20 },
  { customerId: "cust_0009", channel: "email", source: "email_unsubscribe", minutesAgo: 60 * 24 * 9 },
  { customerId: "cust_0012", channel: "sms", source: "manual", minutesAgo: 60 * 24 * 30 }
];
