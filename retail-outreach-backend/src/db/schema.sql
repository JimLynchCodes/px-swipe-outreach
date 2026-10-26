CREATE TABLE IF NOT EXISTS customers (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  first_name TEXT NOT NULL,
  age_band TEXT,
  gender TEXT,
  preferred_store TEXT,
  phone TEXT,
  email TEXT,
  sms_consent BOOLEAN NOT NULL DEFAULT FALSE,
  email_consent BOOLEAN NOT NULL DEFAULT FALSE,
  opted_out BOOLEAN NOT NULL DEFAULT FALSE,
  lifetime_spend_cents INTEGER NOT NULL DEFAULT 0,
  last_purchase_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  price_cents INTEGER NOT NULL DEFAULT 0,
  in_stock BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  store_name TEXT,
  purchased_at TIMESTAMPTZ NOT NULL,
  total_cents INTEGER NOT NULL DEFAULT 0,
  gross_profit_cents INTEGER,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS order_items (
  tenant_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price_cents INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS offers (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  discount_percent INTEGER NOT NULL CHECK (discount_percent BETWEEN 0 AND 100),
  combinable BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  rules JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS outreach_opportunities (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  offer_id TEXT,
  score NUMERIC NOT NULL DEFAULT 0,
  rationale TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','drafted','skipped','queued','sent','failed','suppressed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS outreach_drafts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL REFERENCES outreach_opportunities(id),
  channel TEXT NOT NULL CHECK (channel IN ('sms','email')),
  message TEXT NOT NULL,
  subject TEXT,
  rationale TEXT NOT NULL,
  offer_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  edited_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS message_deliveries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL REFERENCES outreach_opportunities(id),
  draft_id TEXT NOT NULL REFERENCES outreach_drafts(id),
  channel TEXT NOT NULL CHECK (channel IN ('sms','email')),
  recipient TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','sending','sent','delivered','failed')),
  provider_message_id TEXT,
  error TEXT,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS outreach_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  opportunity_id TEXT NOT NULL REFERENCES outreach_opportunities(id),
  actor_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS opportunities_queue_idx
  ON outreach_opportunities (tenant_id, status, score DESC, created_at);
CREATE INDEX IF NOT EXISTS deliveries_opportunity_idx
  ON message_deliveries (tenant_id, opportunity_id, created_at DESC);

-- Small demo dataset. Only inserted if the demo customer is absent.
INSERT INTO customers
(id, tenant_id, first_name, age_band, gender, preferred_store, phone, email,
 sms_consent, email_consent, lifetime_spend_cents, last_purchase_at)
VALUES
('cust_demo', 'demo-retailer', 'Alex', '35-44', NULL, 'Downtown',
 '+15555550123', 'alex@example.com', TRUE, TRUE, 124000,
 NOW() - INTERVAL '74 days')
ON CONFLICT (tenant_id, id) DO NOTHING;

INSERT INTO products (id, tenant_id, name, category, price_cents, in_stock)
VALUES
('prod_tote', 'demo-retailer', 'Leather Tote Bag', 'bags', 18000, TRUE),
('prod_wallet', 'demo-retailer', 'Leather Wallet', 'accessories', 6500, TRUE)
ON CONFLICT (tenant_id, id) DO NOTHING;

INSERT INTO orders (id, tenant_id, customer_id, store_name, purchased_at, total_cents, gross_profit_cents)
VALUES ('order_demo', 'demo-retailer', 'cust_demo', 'Downtown',
 NOW() - INTERVAL '74 days', 18000, 9000)
ON CONFLICT (tenant_id, id) DO NOTHING;

INSERT INTO order_items (tenant_id, order_id, product_id, product_name, quantity, unit_price_cents)
SELECT 'demo-retailer', 'order_demo', 'prod_tote', 'Leather Tote Bag', 1, 18000
WHERE NOT EXISTS (SELECT 1 FROM order_items WHERE tenant_id='demo-retailer' AND order_id='order_demo');

INSERT INTO campaigns (id, tenant_id, name, type, active, config)
VALUES
('winback', 'demo-retailer', 'Win-back', 'win_back', TRUE, '{"minDaysSincePurchase":60}'::jsonb),
('vip', 'demo-retailer', 'VIP appreciation', 'vip_thanks', TRUE, '{"minLifetimeSpendCents":100000}'::jsonb)
ON CONFLICT (tenant_id, id) DO NOTHING;

INSERT INTO offers (id, tenant_id, name, discount_percent, combinable, active, rules)
VALUES ('WINBACK10', 'demo-retailer', 'Win-back 10%', 10, TRUE, TRUE, '{"minDaysSincePurchase":60}'::jsonb)
ON CONFLICT (tenant_id, id) DO NOTHING;

INSERT INTO outreach_opportunities
(id, tenant_id, customer_id, campaign_id, offer_id, score, rationale, status)
SELECT 'opp_demo', 'demo-retailer', 'cust_demo', 'winback', 'WINBACK10', 80,
  'Loyal customer with no purchase in over 60 days', 'pending'
WHERE NOT EXISTS (SELECT 1 FROM outreach_opportunities WHERE id='opp_demo');
