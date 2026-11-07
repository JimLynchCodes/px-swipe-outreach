/**
 * Local mock of the Quickvee merchant portal, implementing exactly the selectors in src/sync/quickvee/selectors.ts.
 * Used by tests; also runnable for manual work: `npm run quickvee:mock` → http://localhost:4799 (demo@store.test / pw).
 * Options: mfa (login asks for a code), csv (export links present; false = crawl only), pageSize.
 */
import http from "node:http";
import { pathToFileURL } from "node:url";

export const MOCK_USER = { email: "demo@store.test", password: "correct-horse" };
export const MOCK_REWARDS = [
  { id: "R100", name: "Jamal Carter", phone: "(555) 010-0001", email: "jamal@example.com", points: 340, joined: "03/14/2025" },
  { id: "R101", name: "Sarah Kim", phone: "555-010-0002", email: "SARAH@EXAMPLE.COM", points: 1200, joined: "11/02/2024" },
  { id: "R102", name: "Lily Ortiz", phone: "", email: "lily@example.com", points: 15, joined: "10/30/2026" }
];
export const MOCK_ORDERS = [
  { id: "O-9001", date: "2026-11-02 10:15", customer: "Jamal Carter", phone: "(555) 010-0001", email: "", payment: "Card", discount: "1.00",
    items: [{ name: "Arturo Fuente Hemingway", sku: "AF-HEM", category: "Cigars", brand: "Arturo Fuente", qty: 2, price: "9.50", discount: "0.00" },
            { name: "Zig-Zag Papers", sku: "ZZ-1", category: "Papers", brand: "Zig-Zag", qty: 1, price: "2.00", discount: "0.00" }] },
  { id: "O-9002", date: "2026-11-05 18:40", customer: "Walk-in", phone: "", email: "", payment: "Cash", discount: "0.00",
    items: [{ name: "Lighter", sku: "BIC-1", category: "Accessories", brand: "BIC", qty: 1, price: "1.99", discount: "0.00" }] },
  { id: "O-8800", date: "2026-09-20 15:00", customer: "Sarah Kim", phone: "", email: "sarah@example.com", payment: "Card", discount: "0.00",
    items: [{ name: "Geek Bar Pulse", sku: "GB-P", category: "Vapes", brand: "Geek Bar", qty: 1, price: "19.99", discount: "2.00" }] }
];

const money = (n: number) => n.toFixed(2);
const total = (o: (typeof MOCK_ORDERS)[number]) => o.items.reduce((s, i) => s + i.qty * Number(i.price) - Number(i.discount), 0) - Number(o.discount);
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const page = (body: string, authed: boolean) => `<!doctype html><html><body>${authed ? '<nav><span data-testid="account-menu">Demo Store</span></nav>' : ""}${body}</body></html>`;
const csvCell = (v: unknown) => `"${String(v).replace(/"/g, '""')}"`;

export type MockOptions = { mfa?: boolean; csv?: boolean; pageSize?: number; port?: number };
export type MockPortal = { url: string; close: () => Promise<void>; requests: string[]; logins: number };

export async function startMockPortal(o: MockOptions = {}): Promise<MockPortal> {
  const sessions = new Set<string>();
  const pending = new Set<string>();
  const state: MockPortal = { url: "", close: async () => {}, requests: [], logins: 0 };
  const size = o.pageSize ?? 2;
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    state.requests.push(`${req.method} ${u.pathname}${u.search}`);
    const sid = /sid=([a-z0-9]+)/.exec(req.headers.cookie ?? "")?.[1];
    const authed = !!sid && sessions.has(sid);
    const html = (s: string, code = 200) => { res.writeHead(code, { "content-type": "text/html" }); res.end(s); };
    const body = async () => { let b = ""; for await (const c of req) b += c; return new URLSearchParams(b); };

    if (u.pathname === "/login" && req.method === "POST") {
      const f = await body();
      if (f.get("email") !== MOCK_USER.email || f.get("password") !== MOCK_USER.password) return html(page('<p data-testid="login-error">Invalid login</p>', false), 401);
      const id = Math.random().toString(36).slice(2);
      state.logins++;
      if (o.mfa) { pending.add(id); res.writeHead(302, { location: "/mfa", "set-cookie": `sid=${id}; Path=/; HttpOnly` }); return res.end(); }
      sessions.add(id);
      res.writeHead(302, { location: "/dashboard", "set-cookie": `sid=${id}; Path=/; HttpOnly` }); return res.end();
    }
    if (u.pathname === "/login") return html(page(`<form method="post" action="/login"><input name="email"><input name="password" type="password"><button type="submit">Sign in</button></form>`, false));
    if (u.pathname === "/mfa") return html(page('<div data-testid="mfa-challenge"><input name="otp"></div>', false));
    if (!authed) { res.writeHead(302, { location: "/login" }); return res.end(); }

    if (u.pathname === "/dashboard") return html(page("<h1>Dashboard</h1>", true));
    if (u.pathname === "/rewards/export.csv") {
      res.writeHead(200, { "content-type": "text/csv", "content-disposition": 'attachment; filename="rewards.csv"' });
      return res.end(["Customer ID,Customer Name,Phone Number,Email,Reward Points,Signup Date", ...MOCK_REWARDS.map(r => [r.id, r.name, r.phone, r.email, r.points, r.joined].map(csvCell).join(","))].join("\n"));
    }
    if (u.pathname === "/rewards") {
      const p = Number(u.searchParams.get("page") ?? 1);
      const rows = MOCK_REWARDS.slice((p - 1) * size, p * size).map(r => `<tr>${(["id", "name", "phone", "email", "points", "joined"] as const).map(c => `<td data-col="${c}">${esc(String(r[c]))}</td>`).join("")}</tr>`).join("");
      return html(page(`${o.csv !== false ? '<a data-action="export-csv" href="/rewards/export.csv" download>Export CSV</a>' : ""}<table class="rewards-table"><tbody>${rows}</tbody></table>${p * size < MOCK_REWARDS.length ? `<a rel="next" href="/rewards?page=${p + 1}">Next</a>` : ""}`, true));
    }
    const inRange = (from: string, to: string) => MOCK_ORDERS.filter(x => x.date.slice(0, 10) >= from && x.date.slice(0, 10) <= to);
    if (u.pathname === "/orders/export.csv") {
      const rows = inRange(u.searchParams.get("from")!, u.searchParams.get("to")!).flatMap(x => x.items.map(i => [x.id, x.date, x.customer, x.phone, x.email, i.name, i.sku, i.category, i.brand, i.qty, i.price, i.discount, x.discount, money(total(x)), x.payment]));
      res.writeHead(200, { "content-type": "text/csv", "content-disposition": 'attachment; filename="orders.csv"' });
      return res.end(["Order ID,Order Date,Customer Name,Phone,Email,Item Name,SKU,Category,Brand,Qty,Unit Price,Item Discount,Order Discount,Total,Payment Type", ...rows.map(r => r.map(csvCell).join(","))].join("\n"));
    }
    if (u.pathname === "/orders") {
      const from = u.searchParams.get("from")!, to = u.searchParams.get("to")!, p = Number(u.searchParams.get("page") ?? 1);
      const all = inRange(from, to);
      const rows = all.slice((p - 1) * size, p * size).map(x => `<tr><td data-col="orderId"><a data-order-link href="/orders/${x.id}">${x.id}</a></td><td data-col="date">${x.date}</td><td data-col="customer">${esc(x.customer)}</td><td data-col="phone">${x.phone}</td><td data-col="email">${x.email}</td><td data-col="subtotal"></td><td data-col="discount">${x.discount}</td><td data-col="total">$${money(total(x))}</td><td data-col="payment">${x.payment}</td></tr>`).join("");
      return html(page(`${o.csv !== false ? `<a data-action="export-csv" href="/orders/export.csv?from=${from}&to=${to}" download>Export</a>` : ""}<table class="orders-table"><tbody>${rows}</tbody></table>${p * size < all.length ? `<a rel="next" href="/orders?from=${from}&to=${to}&page=${p + 1}">Next</a>` : ""}`, true));
    }
    const m = /^\/orders\/([\w-]+)$/.exec(u.pathname);
    const ord = m && MOCK_ORDERS.find(x => x.id === m[1]);
    if (ord) {
      const rows = ord.items.map(i => `<tr><td data-col="name">${esc(i.name)}</td><td data-col="sku">${i.sku}</td><td data-col="category">${i.category}</td><td data-col="brand">${i.brand}</td><td data-col="qty">${i.qty}</td><td data-col="price">${i.price}</td><td data-col="discount">${i.discount}</td></tr>`).join("");
      return html(page(`<table class="order-items"><tbody>${rows}</tbody></table>`, true));
    }
    html("not found", 404);
  });
  await new Promise<void>(r => server.listen(o.port ?? 0, "127.0.0.1", () => r()));
  const addr = server.address() as { port: number };
  state.url = `http://127.0.0.1:${addr.port}`;
  state.close = () => new Promise(r => server.close(() => r()));
  return state;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const p = await startMockPortal({ port: Number(process.env.PORT ?? 4799), mfa: process.env.MFA === "1", csv: process.env.CSV !== "0" });
  console.log(`Mock Quickvee portal at ${p.url} (login ${MOCK_USER.email} / ${MOCK_USER.password})`);
}
