import type pg from "pg";
import * as seed from "../data/seed.js";
import { buildSeedOpportunities } from "../store/memory.js";

/** Upserts the demo dataset. Safe to run repeatedly; does not reset opportunity status. */
export async function seedDemoData(pool: pg.Pool, tenant = seed.DEMO_TENANT) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const p of seed.products) {
      await client.query(`INSERT INTO products (id,tenant_id,name,category,price_cents,image_url) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (tenant_id,id) DO UPDATE SET name=EXCLUDED.name, category=EXCLUDED.category,
          price_cents=EXCLUDED.price_cents, image_url=EXCLUDED.image_url`,
        [p.id, tenant, p.name, p.category, p.priceCents, p.imageUrl]);
    }
    for (const c of seed.campaigns) {
      await client.query(`INSERT INTO campaigns (id,tenant_id,name,type) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [c.id, tenant, c.name, c.type]);
    }
    for (const o of seed.offers) {
      await client.query(`INSERT INTO offers (id,tenant_id,name,discount_percent,combinable) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [o.id, tenant, o.name, o.discountPercent, o.combinable]);
    }
    const opps = buildSeedOpportunities();
    for (const [i, opp] of opps.entries()) {
      const c = opp.customer;
      await client.query(`INSERT INTO customers (id,tenant_id,first_name,last_name,age,gender,location,stores_shopped,
          phone,email,sms_consent,email_consent,lifetime_spend_cents,last_purchase_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (tenant_id,id) DO UPDATE SET last_purchase_at=EXCLUDED.last_purchase_at,
          lifetime_spend_cents=EXCLUDED.lifetime_spend_cents`,
        [c.id, tenant, c.firstName, c.lastName, c.age, c.gender, c.location, c.storesShopped,
          c.phone, c.email, c.smsConsent, c.emailConsent, c.lifetimeSpendCents, c.lastPurchaseAt]);
      for (const [j, p] of c.purchases.entries()) {
        const orderId = `order_${c.id}_${j}`;
        await client.query(`INSERT INTO orders (id,tenant_id,customer_id,store_name,purchased_at,total_cents)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id,id) DO UPDATE SET purchased_at=EXCLUDED.purchased_at`,
          [orderId, tenant, c.id, c.storesShopped[0], p.purchasedAt, p.priceCents]);
        await client.query(`INSERT INTO order_items (tenant_id,order_id,product_id,product_name,unit_price_cents)
          VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [tenant, orderId, p.productId, p.name, p.priceCents]);
      }
      await client.query(`INSERT INTO outreach_opportunities (id,tenant_id,customer_id,campaign_id,offer_id,score,rationale,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7, NOW() - make_interval(secs => $8)) ON CONFLICT (id) DO NOTHING`,
        [opp.id, tenant, c.id, opp.campaign.id, opp.offer?.id ?? null, opp.score, opp.rationale, opps.length - i]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
