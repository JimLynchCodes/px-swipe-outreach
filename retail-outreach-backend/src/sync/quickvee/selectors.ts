/**
 * Every Quickvee selector and path in one place. The real merchant portal's markup isn't documented, so these must be
 * calibrated once with a headed run (see docs/DATA_SYNC.md → "Calibrating Quickvee selectors"). The mock portal in
 * test/fixtures/quickveePortal.ts implements exactly these, so tests pin the scraper's contract.
 */
export const QV = {
  paths: {
    login: "/login",
    home: "/dashboard",
    rewards: (page: number) => `/rewards?page=${page}`,
    orders: (from: string, to: string, page: number) => `/orders?from=${from}&to=${to}&page=${page}`
  },
  login: {
    email: 'input[name="email"]',
    password: 'input[name="password"]',
    submit: 'button[type="submit"]',
    error: '[data-testid="login-error"]',
    mfa: 'input[name="otp"], [data-testid="mfa-challenge"]'
  },
  loggedIn: '[data-testid="account-menu"]',
  exportCsv: 'a[data-action="export-csv"], button[data-action="export-csv"]',
  nextPage: 'a[rel="next"]',
  rewards: { row: "table.rewards-table tbody tr", cell: (col: string) => `td[data-col="${col}"]` },
  orders: { row: "table.orders-table tbody tr", cell: (col: string) => `td[data-col="${col}"]`, detailLink: "a[data-order-link]" },
  orderItems: { row: "table.order-items tbody tr", cell: (col: string) => `td[data-col="${col}"]` }
} as const;

/** CSV header aliases (lowercased, non-alphanumerics stripped) → our fields. */
export const CSV_ALIASES: Record<string, string[]> = {
  id: ["id", "customerid", "memberid", "rewardsid"],
  name: ["name", "customername", "customer", "fullname"],
  firstName: ["firstname"], lastName: ["lastname"],
  phone: ["phone", "phonenumber", "mobile", "customerphone"],
  email: ["email", "emailaddress", "customeremail"],
  points: ["points", "rewardpoints", "pointsbalance", "balance"],
  joined: ["joined", "signupdate", "joindate", "datejoined", "createdat", "signedup"],
  orderId: ["orderid", "order", "ordernumber", "orderno"],
  date: ["date", "orderdate", "createdat", "datetime"],
  item: ["item", "itemname", "product", "productname"],
  sku: ["sku", "upc", "itemsku"],
  category: ["category", "itemcategory", "department"],
  brand: ["brand", "vendor", "manufacturer"],
  qty: ["qty", "quantity"],
  unitPrice: ["unitprice", "price", "itemprice"],
  itemDiscount: ["itemdiscount", "linediscount"],
  orderDiscount: ["orderdiscount", "discount", "discounts", "totaldiscount"],
  subtotal: ["subtotal"],
  total: ["total", "ordertotal", "grandtotal"],
  payment: ["payment", "paymenttype", "paymentmethod", "tender"]
};
