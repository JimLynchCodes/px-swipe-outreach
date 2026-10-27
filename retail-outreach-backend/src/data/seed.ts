/**
 * Demo dataset shared by the in-memory store and the Postgres migration.
 * Dates are relative to "now" so the demo always looks fresh.
 */
/** Fixed identifiers for the demo organization and its owner (used by demo auth and the seed script). */
export const DEMO_ORG_ID = "00000000-0000-4000-8000-000000000101";
export const DEMO_ORG = { id: DEMO_ORG_ID, name: "Demo Retailer", slug: "demo-retailer", businessName: "our store" };
export const DEMO_USER_ID = "00000000-0000-4000-8000-000000000001";
export const DEMO_USER_EMAIL = "demo@px-outreach.local";

export type SeedProduct = { id: string; name: string; category: string; priceCents: number; imageUrl: string | null };
export type SeedCustomer = {
  id: string; firstName: string; lastName: string; age: number; gender: string; location: string;
  storesShopped: string[]; phone: string | null; email: string | null;
  smsConsent: boolean; emailConsent: boolean;
  /** [productId, daysAgo] most recent first */
  purchases: Array<[string, number]>;
  /** Extra historical spend not represented by the line items above. */
  extraSpendCents?: number;
};

export const products: SeedProduct[] = [
  { id: "prod_tote", name: "Leather Tote Bag", category: "bags", priceCents: 16000, imageUrl: null },
  { id: "prod_wallet", name: "Wallet", category: "accessories", priceCents: 6500, imageUrl: null },
  { id: "prod_scarf", name: "Scarf", category: "accessories", priceCents: 4500, imageUrl: null },
  { id: "prod_sneakers", name: "Canvas Sneakers", category: "shoes", priceCents: 8900, imageUrl: null },
  { id: "prod_denim", name: "Slim Denim Jacket", category: "outerwear", priceCents: 12800, imageUrl: null },
  { id: "prod_watch", name: "Minimalist Watch", category: "accessories", priceCents: 21000, imageUrl: null },
  { id: "prod_sunglasses", name: "Sunglasses", category: "accessories", priceCents: 7500, imageUrl: null },
  { id: "prod_boots", name: "Chelsea Boots", category: "shoes", priceCents: 18500, imageUrl: null },
  { id: "prod_sweater", name: "Merino Sweater", category: "tops", priceCents: 9800, imageUrl: null },
  { id: "prod_backpack", name: "Everyday Backpack", category: "bags", priceCents: 11000, imageUrl: null },
  { id: "prod_belt", name: "Leather Belt", category: "accessories", priceCents: 5500, imageUrl: null },
  { id: "prod_dress", name: "Linen Midi Dress", category: "dresses", priceCents: 13500, imageUrl: null }
];

const c = (
  id: string, firstName: string, lastName: string, age: number, gender: string, location: string,
  storesShopped: string[], purchases: Array<[string, number]>,
  opts: Partial<Pick<SeedCustomer, "phone" | "email" | "smsConsent" | "emailConsent" | "extraSpendCents">> = {}
): SeedCustomer => ({
  id, firstName, lastName, age, gender, location, storesShopped, purchases,
  phone: opts.phone === undefined ? `+1555555${id.slice(-4).padStart(4, "0")}` : opts.phone,
  email: opts.email === undefined ? `${firstName.toLowerCase()}@example.com` : opts.email,
  smsConsent: opts.smsConsent ?? true,
  emailConsent: opts.emailConsent ?? true,
  extraSpendCents: opts.extraSpendCents ?? 0
});

export const customers: SeedCustomer[] = [
  c("cust_0001", "Sarah", "Miller", 34, "Female", "Downtown", ["Downtown", "Westside"],
    [["prod_tote", 68], ["prod_wallet", 120], ["prod_scarf", 150]], { extraSpendCents: 59000 }),
  c("cust_0002", "James", "Carter", 41, "Male", "Westside", ["Westside"],
    [["prod_boots", 95], ["prod_belt", 95]], { extraSpendCents: 42000 }),
  c("cust_0003", "Priya", "Shah", 29, "Female", "Northgate", ["Northgate", "Downtown"],
    [["prod_dress", 21], ["prod_sunglasses", 60]]),
  c("cust_0004", "Marcus", "Lee", 52, "Male", "Downtown", ["Downtown"],
    [["prod_watch", 180], ["prod_wallet", 400]], { extraSpendCents: 95000 }),
  c("cust_0005", "Elena", "Garcia", 37, "Female", "Eastport", ["Eastport"],
    [["prod_sweater", 75]], { phone: null, smsConsent: false }),
  c("cust_0006", "Tom", "Nguyen", 26, "Male", "Westside", ["Westside", "Northgate"],
    [["prod_sneakers", 33], ["prod_backpack", 90]]),
  c("cust_0007", "Aisha", "Bello", 45, "Female", "Northgate", ["Northgate"],
    [["prod_tote", 210], ["prod_scarf", 210]], { extraSpendCents: 30000 }),
  c("cust_0008", "Daniel", "Kim", 31, "Male", "Downtown", ["Downtown", "Eastport"],
    [["prod_denim", 62], ["prod_belt", 140]]),
  c("cust_0009", "Hannah", "Wright", 58, "Female", "Eastport", ["Eastport", "Downtown"],
    [["prod_sweater", 120], ["prod_scarf", 300]], { extraSpendCents: 128000 }),
  c("cust_0010", "Luis", "Romero", 39, "Male", "Westside", ["Westside"],
    [["prod_sunglasses", 85]]),
  c("cust_0011", "Grace", "Okafor", 23, "Female", "Downtown", ["Downtown"],
    [["prod_dress", 44], ["prod_tote", 160]]),
  c("cust_0012", "Ben", "Fischer", 47, "Male", "Northgate", ["Northgate", "Westside"],
    [["prod_boots", 260]], { extraSpendCents: 54000 }),
  c("cust_0013", "Mia", "Rossi", 33, "Female", "Westside", ["Westside", "Downtown"],
    [["prod_backpack", 71], ["prod_sneakers", 71], ["prod_wallet", 200]]),
  c("cust_0014", "Owen", "Patel", 28, "Male", "Eastport", ["Eastport"],
    [["prod_watch", 66]], { email: null, emailConsent: false }),
  c("cust_0015", "Chloe", "Dubois", 36, "Female", "Downtown", ["Downtown", "Northgate"],
    [["prod_scarf", 90], ["prod_sweater", 90]]),
  c("cust_0016", "Noah", "Andersen", 44, "Male", "Westside", ["Westside"],
    [["prod_denim", 130], ["prod_boots", 300]], { extraSpendCents: 61000 }),
  c("cust_0017", "Zoe", "Martin", 27, "Female", "Northgate", ["Northgate"],
    [["prod_sunglasses", 25], ["prod_dress", 110]]),
  c("cust_0018", "Ethan", "Brooks", 50, "Male", "Downtown", ["Downtown", "Eastport"],
    [["prod_belt", 77], ["prod_wallet", 77]], { extraSpendCents: 20000 }),
  c("cust_0019", "Lily", "Chen", 31, "Female", "Eastport", ["Eastport", "Westside"],
    [["prod_tote", 102], ["prod_sunglasses", 180]]),
  c("cust_0020", "Ryan", "Walsh", 38, "Male", "Westside", ["Westside"],
    [["prod_sneakers", 64], ["prod_sweater", 64]], { extraSpendCents: 15000 })
];

export const campaigns = [
  { id: "winback", type: "win_back", name: "Win-back" },
  { id: "vip", type: "vip_thanks", name: "VIP appreciation" },
  { id: "nurture", type: "nurture", name: "Follow-up" }
] as const;

export const offers = [
  { id: "WINBACK10", name: "Win-back 10%", discountPercent: 10, combinable: true },
  { id: "VIP15", name: "VIP 15%", discountPercent: 15, combinable: false }
];

/** Simple rule-based targeting, mirrored in the Postgres seeding. */
export function chooseCampaign(daysSinceLastPurchase: number, lifetimeSpendCents: number) {
  if (lifetimeSpendCents >= 100_000) return { campaignId: "vip", offerId: "VIP15", score: 90, rationale: "High lifetime spend; a thank-you keeps them loyal" };
  if (daysSinceLastPurchase >= 60) return { campaignId: "winback", offerId: "WINBACK10", score: 80, rationale: `No purchase in ${daysSinceLastPurchase} days` };
  return { campaignId: "nurture", offerId: null, score: 60, rationale: "Recent shopper; suggest something that pairs with their last purchase" };
}

export function productById(id: string): SeedProduct {
  const p = products.find(x => x.id === id);
  if (!p) throw new Error(`Unknown seed product ${id}`);
  return p;
}

export function lifetimeSpend(customer: SeedCustomer): number {
  return customer.purchases.reduce((sum, [pid]) => sum + productById(pid).priceCents, 0) + (customer.extraSpendCents ?? 0);
}
