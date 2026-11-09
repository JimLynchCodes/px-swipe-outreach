/**
 * Every Quickvee selector and path in one place. The real merchant portal's markup isn't documented, so these must be
 * calibrated once with a headed run (see docs/DATA_SYNC.md → "Calibrating Quickvee selectors"). The mock portal in
 * test/fixtures/quickveePortal.ts implements exactly these, so tests pin the scraper's contract.
 */
export const QV = {
  paths: {
    login: "/merchants/login",
    /** First page after login; also the session check. The real portal lives at https://quickvee.com/merchants/…. */
    home: "/merchants/order-new",
    rewards: (page: number) => `/rewards?page=${page}`,
    /** "Orders Management": In-Store / Online tabs, Start/End date inputs, "Showing N orders", infinite-scroll order blocks. */
    orders: "/merchants/order-new"
  },
  /** Text that only appears when signed in (any of these). */
  loggedInText: /Orders Management|Sign out|Log out|Logout/i,
  /** Login by position: 1st visible text/email input = store name, 2nd = username, 1st password input = password. */
  login: {
    textInputs: 'input:not([type]), input[type="text"], input[type="email"]',
    password: 'input[type="password"]',
    submit: 'button[type="submit"]',
    error: '[data-testid="login-error"]',
    mfa: 'input[name="otp"], [data-testid="mfa-challenge"]'
  },
  loggedIn: '[data-testid="account-menu"]',
  exportCsv: 'a[data-action="export-csv"], button[data-action="export-csv"]',
  nextPage: 'a[rel="next"]',
  rewards: { row: "table.rewards-table tbody tr", cell: (col: string) => `td[data-col="${col}"]` },
  /**
   * Orders Management page. The markup isn't documented, so blocks are found by content, not class names: an order block
   * is the nearest ancestor of an order-ID line (e.g. F3E37BE717735EA1) that also holds a "View Details" button.
   */
  ordersPage: {
    tab: (channel: "in-store" | "online") => (channel === "online" ? /^\s*Online\s*$/i : /^\s*In[-\s]?Store\s*$/i),
    startDate: { label: /start\s*date/i, css: 'input[name*="start" i], input[id*="start" i], input[placeholder*="MM/DD/YYYY" i]' },
    endDate: { label: /end\s*date/i, css: 'input[name*="end" i], input[id*="end" i]' },
    showing: /Showing\s+([\d,]+)\s+orders?/i,
    refundedOnly: /Refunded\s+Only\s+([\d,]+)/i,
    orderId: "^[0-9A-F]{10,24}$",
    viewDetails: /^\s*View\s+Details\s*$/i,
    showItems: /^\s*Show\s+Items\s*$/i,
    hideItems: /^\s*Hide\s+Items\s*$/i,
    walkIn: /^walk[-\s]?in(\s+customer)?$/i
  },
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
  /** Preferred order-level amount spent (Quickvee / exports). Takes precedence over Total / line prices. */
  orderTotalPaid: ["ordertotalpaid", "totalpaid", "amountpaid", "amountspent", "ordertotalamount"],
  total: ["total", "ordertotal", "grandtotal", "ordertotalpaid", "totalpaid"],
  payment: ["payment", "paymenttype", "paymentmethod", "tender"],
  status: ["status", "orderstatus", "refundstatus"]
};
