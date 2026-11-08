/**
 * Local mock of the Quickvee merchant portal, implementing exactly the selectors in src/sync/quickvee/selectors.ts.
 * Used by tests; also runnable for manual work: `npm run quickvee:mock` → http://localhost:4799 (demo@store.test / pw).
 * Options: mfa (login asks for a code), csv (rewards export link; false = crawl only), pageSize, json (orders list from JSON; false = HTML only), orders, ordersPageSize.
 */
import http from "node:http";
import { pathToFileURL } from "node:url";

export const MOCK_USER = { storeName: "cloud9-qv-store", username: "qv-user-7731", password: "correct-horse" };
export const MOCK_REWARDS = [
  { id: "R100", name: "Jamal Carter", phone: "(555) 010-0001", email: "jamal@example.com", points: 340, joined: "03/14/2025" },
  { id: "R101", name: "Sarah Kim", phone: "555-010-0002", email: "SARAH@EXAMPLE.COM", points: 1200, joined: "11/02/2024" },
  { id: "R102", name: "Lily Ortiz", phone: "", email: "lily@example.com", points: 15, joined: "10/30/2026" }
];
/** Orders as the Orders Management page shows them (store-local MM/DD/YYYY h:mm AM/PM, newest first). */
export type MockOrder = { id: string; date: string; customer: string; phone: string; email: string; payment: string; discount: string;
  employee: string; channel: "in-store" | "online"; refunded?: boolean;
  items: Array<{ name: string; sku: string; category: string; brand: string; qty: number; price: string; discount: string }> };
export const MOCK_ORDERS: MockOrder[] = [
  { id: "F3E37BE717735EA1", date: "11/02/2026 10:15 AM", customer: "Jamal Carter", phone: "(555) 010-0001", email: "", payment: "Card", discount: "1.00", employee: "Fawad Bro", channel: "in-store",
    items: [{ name: "Arturo Fuente Hemingway", sku: "AF-HEM", category: "Cigars", brand: "Arturo Fuente", qty: 2, price: "9.50", discount: "0.00" },
            { name: "Zig-Zag Papers", sku: "ZZ-1", category: "Papers", brand: "Zig-Zag", qty: 1, price: "2.00", discount: "0.00" }] },
  { id: "90699FBBCCAF9E11", date: "11/05/2026 06:40 PM", customer: "Walk-In Customer", phone: "", email: "", payment: "Cash", discount: "0.00", employee: "Fawad Bro", channel: "in-store",
    items: [{ name: "Lighter", sku: "BIC-1", category: "Accessories", brand: "BIC", qty: 1, price: "1.99", discount: "0.00" }] },
  { id: "0A1B2C3D4E5F6071", date: "09/20/2026 03:00 PM", customer: "Sarah Kim", phone: "", email: "sarah@example.com", payment: "Card", discount: "0.00", employee: "Ana", channel: "in-store", refunded: true,
    items: [{ name: "Geek Bar Pulse", sku: "GB-P", category: "Vapes", brand: "Geek Bar", qty: 1, price: "19.99", discount: "2.00" }] },
  { id: "ABCDEF0123456789", date: "10/01/2026 12:00 PM", customer: "Lily Ortiz", phone: "", email: "lily@example.com", payment: "Online", discount: "0.00", employee: "Web", channel: "online",
    items: [{ name: "Grinder", sku: "GR-1", category: "Accessories", brand: "Santa Cruz", qty: 1, price: "30.00", discount: "0.00" }] }
];
/** n synthetic in-store walk-in orders (for scroll/limit/resume tests), one per hour back from 10/31/2026 11 PM. */
export function syntheticOrders(n: number): MockOrder[] {
  return Array.from({ length: n }, (_, i) => {
    const t = new Date(Date.UTC(2026, 9, 31, 23) - i * 3_600_000);
    const h = t.getUTCHours(), pad = (x: number) => String(x).padStart(2, "0");
    return { id: (0xC0000000 + i).toString(16).toUpperCase().padStart(16, "D"), date: `${pad(t.getUTCMonth() + 1)}/${pad(t.getUTCDate())}/${t.getUTCFullYear()} ${pad(h % 12 || 12)}:00 ${h < 12 ? "AM" : "PM"}`,
      customer: "Walk-In Customer", phone: "", email: "", payment: "Cash", discount: "0.00", employee: "Fawad Bro", channel: "in-store" as const,
      items: [{ name: `Item ${i}`, sku: "", category: "", brand: "", qty: 1, price: "5.00", discount: "0.00" }] };
  });
}

const money = (n: number) => n.toFixed(2);
const total = (o: MockOrder) => o.items.reduce((s, i) => s + i.qty * Number(i.price) - Number(i.discount), 0) - Number(o.discount);
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const page = (body: string, authed: boolean) => `<!doctype html><html><body>${authed ? '<nav><span data-testid="account-menu">Demo Store</span></nav>' : ""}${body}</body></html>`;
const csvCell = (v: unknown) => `"${String(v).replace(/"/g, '""')}"`;

export type MockOptions = { mfa?: boolean; csv?: boolean; pageSize?: number; port?: number;
  /** Orders page: false = the list loads HTML fragments (no JSON), exercising the DOM-only path. */
  json?: boolean; orders?: MockOrder[]; ordersPageSize?: number };
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
      if (f.get("store_name") !== MOCK_USER.storeName || f.get("username") !== MOCK_USER.username || f.get("password") !== MOCK_USER.password) return html(page('<p data-testid="login-error">Invalid login</p>', false), 401);
      const id = Math.random().toString(36).slice(2);
      state.logins++;
      if (o.mfa) { pending.add(id); res.writeHead(302, { location: "/mfa", "set-cookie": `sid=${id}; Path=/; HttpOnly` }); return res.end(); }
      sessions.add(id);
      res.writeHead(302, { location: "/dashboard", "set-cookie": `sid=${id}; Path=/; HttpOnly` }); return res.end();
    }
    if (u.pathname === "/login") return html(page(`<form method="post" action="/login"><label for="store">Store name</label><input id="store" name="store_name" placeholder="Enter store name"><label for="user">Username</label><input id="user" name="username" placeholder="Enter username"><label for="pw">Password</label><input id="pw" name="password" type="password" placeholder="Enter password"><button type="submit">Sign in</button></form>`, false));
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
    const orders = o.orders ?? MOCK_ORDERS;
    const ymd = (mdy: string) => `${mdy.slice(6, 10)}-${mdy.slice(0, 2)}-${mdy.slice(3, 5)}`;
    const sortKey = (x: MockOrder) => { const [d, t, ap] = x.date.split(" "); const [h, mi] = t.split(":").map(Number); return `${ymd(d)} ${String((h % 12) + (ap === "PM" ? 12 : 0)).padStart(2, "0")}:${mi}`; };
    const query = (q: URLSearchParams) => {
      const start = ymd(q.get("start") ?? "01/01/2026"), end = ymd(q.get("end") ?? "12/31/2026"), ch = q.get("channel") ?? "in-store";
      return orders.filter(x => x.channel === ch && ymd(x.date) >= start && ymd(x.date) <= end).sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
    };
    const card = (x: MockOrder) => `<div class="order-card"><div class="row"><div><div class="oid">${x.id}</div><div class="when">${x.date}</div></div>
      <div><div class="cust">${esc(x.customer)}</div><span class="chip">${esc(x.employee)}</span></div>${x.refunded ? '<span class="badge">Refunded</span>' : ""}<div class="amt">$${money(total(x))}</div></div>
      <div class="meta"><span>${x.items.length} Item${x.items.length === 1 ? "" : "s"}</span>\n<div>${esc(x.payment)}</div><button class="toggle">Show Items</button></div>
      <div class="items" hidden>${x.items.map(i => `<div class="item-row"><div>${esc(i.name)}</div><div>${i.qty} x $${i.price}</div>${Number(i.discount) ? `<div>Discount: $${i.discount}</div>` : ""}</div>`).join("")}</div>
      <button class="details">View Details</button><div class="modal" hidden><div>Phone: ${x.phone}</div><div>Email: ${x.email}</div><button class="close">Close</button></div></div>`;
    const pageSize = o.ordersPageSize ?? 3;
    if (u.pathname === "/api/merchant/orders") {
      const all = query(u.searchParams), off = Number(u.searchParams.get("offset") ?? 0), slice = all.slice(off, off + pageSize);
      if (o.json === false) { res.writeHead(200, { "content-type": "text/html", "x-total": String(all.length) }); return res.end(slice.map(card).join("")); }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ status: "ok", data: { total: all.length, refunded: all.filter(x => x.refunded).length, orders: slice.map(x => ({
        id: Math.floor(Math.random() * 1e9), order_id: x.id, created_at: x.date, grand_total: total(x).toFixed(2), customer_name: x.customer, customer_phone: x.phone, customer_email: x.email,
        payment_type: x.payment, status: x.refunded ? "Refunded" : "Completed",
        items: x.items.map(i => ({ item_name: i.name, sku: i.sku, category: i.category, brand: i.brand, qty: i.qty, price: i.price, discount: i.discount })) })) } }));
    }
    if (u.pathname === "/merchants/order-new") {
      return html(page(`<header><select aria-label="Store"><option>PINEAPPLE XPRESS MOCK</option></select></header>
<h1>Orders Management</h1><div role="tablist"><button data-ch="in-store" class="tab on">In-Store</button><button data-ch="online" class="tab">Online</button></div>
<input type="search" placeholder="Search by Order ID, Customer Name">
<section><h3>Filters</h3><p>Select date range</p><button type="button">Today</button>
<label for="sd">Start Date</label><input id="sd" placeholder="MM/DD/YYYY" value="${o.json === false ? "11/08/2026" : "11/01/2026"}">
<label for="ed">End Date</label><input id="ed" placeholder="MM/DD/YYYY" value="11/08/2026"></section>
<div class="summary">All Orders <b id="all">0</b> Including refunds · Refunded Only <b id="ref">0</b></div>
<p>Showing <span id="n">0</span> orders</p><button type="button">Export to Excel</button>
<div id="list"></div><div id="spacer" style="height:200px"></div>
<script>
let ch = "in-store", off = 0, total = 0, loading = false, gen = 0;
const ok = v => /^[0-9]{2}[/][0-9]{2}[/][0-9]{4}$/.test(v);
const q = () => "channel=" + ch + "&start=" + encodeURIComponent(sd.value) + "&end=" + encodeURIComponent(ed.value);
const wire = root => root.querySelectorAll(".order-card").forEach(c => {
  c.querySelector(".toggle").onclick = e => { const it = c.querySelector(".items"); it.hidden = !it.hidden; e.target.textContent = it.hidden ? "Show Items" : "Hide Items"; };
  c.querySelector(".details").onclick = () => { c.querySelector(".modal").hidden = false; };
  c.querySelector(".close").onclick = () => { c.querySelector(".modal").hidden = true; };
});
async function load(reset) {
  if (!ok(sd.value) || !ok(ed.value)) return;
  if (reset) { off = 0; list.innerHTML = ""; gen++; }
  const g = gen; loading = true;
  const r = await fetch("/api/merchant/orders?" + q() + "&offset=" + off);
  if (g !== gen) return;
  ${o.json === false
    ? `total = Number(r.headers.get("x-total")); const tmp = document.createElement("div"); tmp.innerHTML = await r.text(); wire(tmp); off += tmp.children.length; list.append(...tmp.children);`
    : `const d = (await r.json()).data; total = d.total; ref.textContent = d.refunded;
  const h = await fetch("/api/merchant/orders/html?" + q() + "&offset=" + off); off += d.orders.length;
  const tmp = document.createElement("div"); tmp.innerHTML = await h.text(); wire(tmp); list.append(...tmp.children);`}
  n.textContent = total; all.textContent = total; loading = false;
}
document.querySelectorAll(".tab").forEach(b => b.onclick = () => { ch = b.dataset.ch; load(true); });
for (const i of [sd, ed]) { i.addEventListener("change", () => load(true)); i.addEventListener("keydown", e => { if (e.key === "Enter") load(true); }); }
window.addEventListener("scroll", () => { if (!loading && off < total && innerHeight + scrollY >= document.body.scrollHeight - 300) load(false); });
load(true);
</script>`, true));
    }
    if (u.pathname === "/api/merchant/orders/html") {
      const all = query(u.searchParams), off = Number(u.searchParams.get("offset") ?? 0);
      res.writeHead(200, { "content-type": "text/html" }); return res.end(all.slice(off, off + pageSize).map(card).join(""));
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
  console.log(`Mock Quickvee portal at ${p.url} (store ${MOCK_USER.storeName}, login ${MOCK_USER.username} / ${MOCK_USER.password})`);
}
