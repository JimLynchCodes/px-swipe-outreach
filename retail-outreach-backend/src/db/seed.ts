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
import { buildDemoMetrics } from "../data/demoMetrics.js";
import { segmentOf } from "../domain.js";
import type { Customer } from "../types.js";
import { createPool } from "./pool.js";
import { appendTx } from "../store/postgres.js";

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
    await db.query(`insert into public.products (id, org_id, external_id, name, brand, category, price_cents, image_url) values ($1,$2,$3,$4,$5,$6,$7,$8)
      on conflict (id) do update set name = excluded.name, brand = excluded.brand, category = excluded.category,
        price_cents = excluded.price_cents, image_url = excluded.image_url`,
      [id(`product:${p.id}`), orgId, p.id, p.name, p.brand, p.category, p.priceCents, p.imageUrl]);
  }
  for (const c of seed.campaigns) {
    await db.query(`insert into public.campaigns (id, org_id, key, name, type) values ($1,$2,$3,$4,$5)
      on conflict (id) do update set name = excluded.name, type = excluded.type`,
      [id(`campaign:${c.id}`), orgId, c.id, c.name, c.type]);
  }
  for (const o of seed.offers) {
    await db.query(`insert into public.offers (id, org_id, code, name, discount_percent, combinable) values ($1,$2,$3,$4,$5,$6)
      on conflict (id) do update set name = excluded.name, discount_percent = excluded.discount_percent, combinable = excluded.combinable`,
      [id(`offer:${o.id}`), orgId, o.id, o.name, o.discountPercent, o.combinable]);
  }
  for (const [i, c] of seed.customers.entries()) {
    const custId = id(`customer:${c.id}`);
    const lifetime = seed.lifetimeSpend(c);
    const lastAt = new Date(now - Math.min(...c.purchases.map(([, d]) => d)) * DAY_MS);
    const pr = c.profile;
    await db.query(`insert into public.customers (id, org_id, external_id, first_name, last_name, age, gender, location, phone, email,
        sms_consent, email_consent, lifetime_spend_cents, last_purchase_at, age_verified, favorite_categories, favorite_brands,
        visits_per_month, avg_basket_cents, preferred_day, preferred_time)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      on conflict (id) do update set first_name = excluded.first_name, last_name = excluded.last_name, age = excluded.age,
        gender = excluded.gender, location = excluded.location, phone = excluded.phone, email = excluded.email,
        sms_consent = excluded.sms_consent, email_consent = excluded.email_consent,
        last_purchase_at = excluded.last_purchase_at, lifetime_spend_cents = excluded.lifetime_spend_cents,
        age_verified = excluded.age_verified, favorite_categories = excluded.favorite_categories, favorite_brands = excluded.favorite_brands,
        visits_per_month = excluded.visits_per_month, avg_basket_cents = excluded.avg_basket_cents,
        preferred_day = excluded.preferred_day, preferred_time = excluded.preferred_time`,
      [custId, orgId, c.id, c.firstName, c.lastName, c.age, c.gender, c.location, c.phone, c.email, c.smsConsent, c.emailConsent, lifetime, lastAt,
        c.ageVerified, pr.favoriteCategories, pr.favoriteBrands, pr.visitsPerMonth, pr.avgBasketCents, pr.preferredDay, pr.preferredTime]);
    const lc = seed.SEED_LAST_CONTACT[c.id];
    if (lc) await db.query(`update public.customers set last_sms_at = now() - make_interval(days => $2::int), last_email_at = now() - make_interval(days => $3::int) where id = $1`,
      [custId, lc.smsDaysAgo ?? null, lc.emailDaysAgo ?? null]);
    const rw = seed.SEED_REWARDS[c.id];
    await db.query(`update public.customers set rewards_member = $2, rewards_points = $3, rewards_joined_at = $4 where id = $1`, [custId, !!rw, rw?.points ?? null, rw?.joinedAt ?? null]);
    for (const [j, [pid, daysAgo]] of c.purchases.entries()) {
      const p = seed.productById(pid);
      const purchaseId = id(`purchase:${c.id}:${j}`);
      const store = c.storesShopped[j % c.storesShopped.length];
      await db.query(`insert into public.purchases (id, org_id, customer_id, store_id, purchased_at, total_cents) values ($1,$2,$3,$4,$5,$6)
        on conflict (id) do update set purchased_at = excluded.purchased_at`,
        [purchaseId, orgId, custId, id(`store:${store}`), new Date(now - daysAgo * DAY_MS - j * 60_000), p.priceCents]);
      await db.query(`insert into public.purchase_items (id, org_id, purchase_id, product_id, product_name, unit_price_cents)
        values ($1,$2,$3,$4,$5,$6) on conflict (id) do update set product_id = excluded.product_id,
          product_name = excluded.product_name, unit_price_cents = excluded.unit_price_cents`,
        [id(`item:${c.id}:${j}`), orgId, purchaseId, id(`product:${pid}`), p.name, p.priceCents]);
    }
    const daysSinceLast = Math.min(...c.purchases.map(([, d]) => d));
    const asCustomer = { lastPurchaseAt: lastAt.toISOString(), profile: pr } as Customer;
    const pick = seed.chooseCampaign(segmentOf(asCustomer, now), lifetime, daysSinceLast);
    await db.query(`insert into public.outreach_opportunities (id, org_id, customer_id, campaign_id, offer_id, score, rationale, created_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (id) do update set campaign_id = excluded.campaign_id, offer_id = excluded.offer_id,
        score = excluded.score, rationale = excluded.rationale`,
      [id(`opp:${c.id}`), orgId, custId, id(`campaign:${pick.campaignId}`), pick.offerId ? id(`offer:${pick.offerId}`) : null,
        pick.score, pick.rationale, new Date(now - (seed.customers.length - i) * 60_000)]);
  }
  await seedDealsAndSettings(db, orgId, id);
  await seedDemoMetrics(db, orgId, id);
}

/** Demo AI usage, sends by fictional staff and attributed purchases (is_demo = true). Only seeded once per org. */
async function seedDemoMetrics(db: pg.PoolClient, orgId: string, id: (n: string) => string) {
  if ((await db.query(`select 1 from public.outreach_sends where org_id = $1 and is_demo limit 1`, [orgId])).rowCount) return;
  const m = buildDemoMetrics();
  const dealUuid = (d: string | null) => d ? id(`deal:${Number(d.slice(5)) - 1}`) : null;
  for (const u of m.usage) {
    await db.query(`insert into public.ai_usage (org_id, model, provider, input_tokens, output_tokens, cost_usd, price_version, deal_id, deal_title,
        led_to_send, sent_channel, is_demo, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12)`,
      [orgId, u.model, u.provider, u.inputTokens, u.outputTokens, u.costUsd, u.priceVersion, dealUuid(u.dealId), u.dealTitle, u.ledToSend, u.sentChannel, u.createdAt]);
  }
  for (const x of m.sends) {
    await db.query(`insert into public.outreach_sends (org_id, user_label, customer_id, channel, deal_id, deal_title, deal_categories, deal_product_ids,
        model, is_demo, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10)`,
      [orgId, x.userLabel, id(`customer:${x.customerId}`), x.channel, dealUuid(x.dealId), x.dealTitle, x.dealCategories,
        x.dealProductIds.map(p => id(`product:${p}`)), x.model, x.createdAt]);
  }
  for (const c of m.smsCosts) {
    await db.query(`insert into public.sms_costs (org_id, provider, message_sid, segments, price_usd, estimated, status, is_demo, created_at, updated_at)
      values ($1,$2,$3,$4,$5,$6,$7,true,$8,$8) on conflict (message_sid) do nothing`,
      [orgId, c.provider, `${c.messageSid}-${orgId.slice(0, 8)}`, c.segments, c.priceUsd, c.estimated, c.status, c.createdAt]);
  }
  for (const [i, p] of m.purchases.entries()) {
    const purchaseId = id(`demo-purchase:${i}`);
    await db.query(`insert into public.purchases (id, org_id, customer_id, purchased_at, total_cents, is_demo) values ($1,$2,$3,$4,$5,true)
      on conflict (id) do nothing`, [purchaseId, orgId, id(`customer:${p.customerId}`), p.purchasedAt, p.priceCents]);
    const prod = seed.productById(p.productId!);
    await db.query(`insert into public.purchase_items (org_id, purchase_id, product_id, product_name, unit_price_cents) values ($1,$2,$3,$4,$5)`,
      [orgId, purchaseId, id(`product:${p.productId}`), prod.name, p.priceCents]);
  }
}

async function seedDealsAndSettings(db: pg.PoolClient, orgId: string, id: (n: string) => string) {
  for (const [i, d] of seed.deals.entries()) {
    await db.query(`insert into public.deals (id, org_id, days, title, description, discount_type, discount_value, categories, product_ids,
        starts_on, ends_on, active, schedule) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) on conflict (id) do nothing`,
      [id(`deal:${i}`), orgId, d.days, d.title, d.description, d.discountType, d.discountValue, d.categories,
        d.productIds.map(p => id(`product:${p}`)), d.startsOn, d.endsOn, d.active, d.schedule]);
  }
  const contactOf = (cid: string, ch: "sms" | "email") => {
    const c = seed.customers.find(x => x.id === cid)!;
    return ch === "sms" ? c.phone : c.email;
  };
  const now = Date.now();
  for (const o of seed.optOuts) {
    const contact = contactOf(o.customerId, o.channel);
    if (!contact) continue;
    const ins = await db.query(`insert into public.suppressions (org_id, channel, value, reason, source, customer_id, created_at)
      values ($1, $2, public.normalize_contact($2::public.outreach_channel, $3), 'opt_out', $4, $5, $6) on conflict do nothing returning value, created_at`,
      [orgId, o.channel, contact, o.source, id(`customer:${o.customerId}`), new Date(now - o.minutesAgo * 60_000)]);
    if (ins.rows[0]) await db.query(`insert into public.consent_events (org_id, channel, value, event, source, created_at) values ($1,$2,$3,'opt_out',$4,$5)`,
      [orgId, o.channel, ins.rows[0].value, o.source, ins.rows[0].created_at]);
  }
  const hasThreads = await db.query(`select 1 from public.conversations where org_id = $1 limit 1`, [orgId]);
  if (!hasThreads.rowCount) {
    for (const t of seed.threads) {
      const contact = contactOf(t.customerId, t.channel);
      if (!contact) continue;
      let conv = "";
      for (const m of t.messages) {
        conv = (await appendTx(db, orgId, t.channel, contact, { direction: m.direction, kind: m.kind ?? "message",
          status: m.direction === "inbound" ? "received" : "sent", body: m.body, subject: m.subject ?? null,
          createdAt: new Date(now - m.minutesAgo * 60_000) })).conversationId;
      }
      if (t.read) await db.query(`update public.conversations set unread_count = 0, last_read_at = now() where id = $1`, [conv]);
    }
  }
  const st = seed.DEMO_SETTINGS;
  await db.query(`insert into public.org_settings (org_id, store_name, email_signature, sms_signature, default_channel, max_discount_percent, brand_voice)
    values ($1,$2,$3,$4,$5,$6,$7) on conflict (org_id) do nothing`,
    [orgId, st.storeName, st.emailSignature, st.smsSignature, st.defaultChannel, st.maxDiscountPercent, JSON.stringify(st.brandVoice)]);
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
