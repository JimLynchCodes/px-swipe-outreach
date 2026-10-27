/**
 * Seeds a demo organization (stores, products, customers, purchases, campaigns, offers, opportunities).
 * Idempotent: ids are deterministic, re-running refreshes the data.
 *
 *   npm run db:seed -- --owner-email you@company.com   # make an existing Supabase Auth user the org owner
 *   npm run db:seed -- --demo-user                     # LOCAL plain Postgres only: create the demo auth user
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import * as seed from "../data/seed.js";
import { createPool } from "./pool.js";

/** Deterministic uuid (v4-shaped) from a name, so re-seeding is idempotent. */
export function seedUuid(orgId: string, name: string) {
  const h = createHash("sha256").update(`${orgId}:${name}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const DAY_MS = 86_400_000;

export async function seedOrg(db: pg.PoolClient, opts: { orgId: string; name: string; slug: string; businessName: string; ownerId: string; now?: number }) {
  const { orgId, ownerId } = opts;
  const now = opts.now ?? Date.now();
  const id = (n: string) => seedUuid(orgId, n);
  await db.query(`insert into public.organizations (id, name, slug, business_name, created_by) values ($1,$2,$3,$4,$5)
    on conflict (id) do update set name = excluded.name, business_name = excluded.business_name`,
    [orgId, opts.name, opts.slug, opts.businessName, ownerId]);
  await db.query(`insert into public.memberships (org_id, user_id, role) values ($1,$2,'owner')
    on conflict (org_id, user_id) do update set role = 'owner'`, [orgId, ownerId]);

  const storeNames = [...new Set(seed.customers.flatMap(c => c.storesShopped))];
  for (const s of storeNames) {
    await db.query(`insert into public.stores (id, org_id, name, location) values ($1,$2,$3,$3) on conflict (id) do nothing`, [id(`store:${s}`), orgId, s]);
  }
  for (const p of seed.products) {
    await db.query(`insert into public.products (id, org_id, external_id, name, category, price_cents, image_url) values ($1,$2,$3,$4,$5,$6,$7)
      on conflict (id) do update set name = excluded.name, price_cents = excluded.price_cents, image_url = excluded.image_url`,
      [id(`product:${p.id}`), orgId, p.id, p.name, p.category, p.priceCents, p.imageUrl]);
  }
  for (const c of seed.campaigns) {
    await db.query(`insert into public.campaigns (id, org_id, key, name, type) values ($1,$2,$3,$4,$5) on conflict (id) do nothing`,
      [id(`campaign:${c.id}`), orgId, c.id, c.name, c.type]);
  }
  for (const o of seed.offers) {
    await db.query(`insert into public.offers (id, org_id, code, name, discount_percent, combinable) values ($1,$2,$3,$4,$5,$6) on conflict (id) do nothing`,
      [id(`offer:${o.id}`), orgId, o.id, o.name, o.discountPercent, o.combinable]);
  }
  for (const [i, c] of seed.customers.entries()) {
    const custId = id(`customer:${c.id}`);
    const lifetime = seed.lifetimeSpend(c);
    const lastAt = new Date(now - Math.min(...c.purchases.map(([, d]) => d)) * DAY_MS);
    await db.query(`insert into public.customers (id, org_id, external_id, first_name, last_name, age, gender, location, phone, email,
        sms_consent, email_consent, lifetime_spend_cents, last_purchase_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      on conflict (id) do update set last_purchase_at = excluded.last_purchase_at, lifetime_spend_cents = excluded.lifetime_spend_cents`,
      [custId, orgId, c.id, c.firstName, c.lastName, c.age, c.gender, c.location, c.phone, c.email, c.smsConsent, c.emailConsent, lifetime, lastAt]);
    for (const [j, [pid, daysAgo]] of c.purchases.entries()) {
      const p = seed.productById(pid);
      const purchaseId = id(`purchase:${c.id}:${j}`);
      const store = c.storesShopped[j % c.storesShopped.length];
      await db.query(`insert into public.purchases (id, org_id, customer_id, store_id, purchased_at, total_cents) values ($1,$2,$3,$4,$5,$6)
        on conflict (id) do update set purchased_at = excluded.purchased_at`,
        [purchaseId, orgId, custId, id(`store:${store}`), new Date(now - daysAgo * DAY_MS), p.priceCents]);
      await db.query(`insert into public.purchase_items (id, org_id, purchase_id, product_id, product_name, unit_price_cents)
        values ($1,$2,$3,$4,$5,$6) on conflict (id) do nothing`,
        [id(`item:${c.id}:${j}`), orgId, purchaseId, id(`product:${pid}`), p.name, p.priceCents]);
    }
    const daysSinceLast = Math.min(...c.purchases.map(([, d]) => d));
    const pick = seed.chooseCampaign(daysSinceLast, lifetime);
    await db.query(`insert into public.outreach_opportunities (id, org_id, customer_id, campaign_id, offer_id, score, rationale, created_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (id) do nothing`,
      [id(`opp:${c.id}`), orgId, custId, id(`campaign:${pick.campaignId}`), pick.offerId ? id(`offer:${pick.offerId}`) : null,
        pick.score, pick.rationale, new Date(now - (seed.customers.length - i) * 60_000)]);
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const args = process.argv.slice(2);
  const emailIdx = args.indexOf("--owner-email");
  const ownerEmail = emailIdx >= 0 ? args[emailIdx + 1] : undefined;
  const demoUser = args.includes("--demo-user");
  if (!ownerEmail && !demoUser) throw new Error("Pass --owner-email <email> (existing Supabase Auth user) or --demo-user (local only)");
  if (demoUser && process.env.NODE_ENV === "production") throw new Error("--demo-user is not allowed in production");

  const pool = createPool(url, { max: 1 });
  const db = await pool.connect();
  try {
    await db.query("begin");
    let ownerId: string;
    if (demoUser) {
      await db.query(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [seed.DEMO_USER_ID, seed.DEMO_USER_EMAIL]);
      ownerId = seed.DEMO_USER_ID;
    } else {
      const r = await db.query(`select id from auth.users where lower(email) = lower($1)`, [ownerEmail]);
      if (!r.rows[0]) throw new Error(`No Supabase Auth user with email ${ownerEmail}. Sign up in the app first, then re-run.`);
      ownerId = r.rows[0].id;
    }
    await seedOrg(db, { orgId: seed.DEMO_ORG_ID, ...seed.DEMO_ORG, ownerId });
    await db.query("commit");
    console.log(`Seeded "${seed.DEMO_ORG.name}" (${seed.DEMO_ORG_ID}) with owner ${ownerId}.`);
  } catch (e) {
    await db.query("rollback");
    throw e;
  } finally {
    db.release();
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
