import { query } from "../db/pool.js";
import type { CustomerSummary, ApprovedProduct } from "../types.js";

/**
 * Replace this adapter with calls to your POS customer/order/product APIs.
 * Keep vendor-specific response shapes inside this module.
 */
export const pos = {
  async getCustomerSummary(tenantId: string, customerId: string): Promise<CustomerSummary | null> {
    const result = await query<any>(`
      SELECT c.*,
        CASE WHEN c.last_purchase_at IS NULL THEN NULL
             ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - c.last_purchase_at))/86400))::int
        END AS days_since_last_purchase
      FROM customers c
      WHERE c.tenant_id=$1 AND c.id=$2
    `, [tenantId, customerId]);
    if (!result.rows[0]) return null;
    const c = result.rows[0];
    const items = await query<any>(`
      SELECT DISTINCT ON (oi.product_id) oi.product_name AS name, p.category, oi.unit_price_cents AS price_cents
      FROM orders o JOIN order_items oi ON oi.tenant_id=o.tenant_id AND oi.order_id=o.id
      LEFT JOIN products p ON p.tenant_id=oi.tenant_id AND p.id=oi.product_id
      WHERE o.tenant_id=$1 AND o.customer_id=$2
      ORDER BY oi.product_id, o.purchased_at DESC
      LIMIT 8
    `, [tenantId, customerId]);
    return {
      id: c.id, firstName: c.first_name, ageBand: c.age_band, gender: c.gender,
      preferredStore: c.preferred_store, phone: c.phone, email: c.email,
      smsConsent: c.sms_consent, emailConsent: c.email_consent, optedOut: c.opted_out,
      lifetimeSpendCents: c.lifetime_spend_cents,
      lastPurchaseAt: c.last_purchase_at ? new Date(c.last_purchase_at).toISOString() : null,
      daysSinceLastPurchase: c.days_since_last_purchase,
      recentItems: items.rows.map((p: any) => ({ name: p.name, category: p.category, priceCents: p.price_cents }))
    };
  },

  async getApprovedProducts(tenantId: string, categories: string[] = []): Promise<ApprovedProduct[]> {
    const result = await query<any>(`
      SELECT id, name, category, price_cents FROM products
      WHERE tenant_id=$1 AND in_stock=TRUE
        AND (cardinality($2::text[])=0 OR category=ANY($2::text[]))
      ORDER BY name LIMIT 12
    `, [tenantId, categories]);
    return result.rows.map((p: any) => ({
      id: p.id, name: p.name, category: p.category, priceCents: p.price_cents
    }));
  }
};
