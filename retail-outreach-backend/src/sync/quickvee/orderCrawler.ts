/**
 * Crawls Quickvee's "Orders Management" page (/merchants/order-new): picks the In-Store/Online tab, types the date range
 * into Start Date / End Date, reads "Showing N orders", then scrolls the infinite list until no new order blocks load.
 *
 * Two sources, merged by order ID:
 *  1. JSON (XHR/fetch) responses the page loads its list from, when they contain order-like objects (fast, has contact
 *     details when the API sends them). Field names aren't documented, so they're matched loosely; the first few bodies
 *     are saved to QUICKVEE_STATE_DIR/raw for calibration.
 *  2. The rendered order blocks (always): ID, date/time, customer, total, item count, payment, refund badge, and the line
 *     items after clicking "Show Items". Optionally "View Details" for phone/email (slow: one click per order).
 */
import type { Order, OrderItem } from "../types.js";
import { normalizeEmail, normalizePhone, toCents, toIso } from "./normalize.js";
import type { QuickveePortal } from "./portal.js";
import { QV } from "./selectors.js";

export type Channel = "in-store" | "online";
export type CrawlOptions = {
  from: string; to: string; channel: Channel; tz: string;
  /** Stop after this many new orders (across the whole crawl). */
  limit?: number;
  /** Order IDs already captured (resume); skipped and not re-emitted. */
  seen?: Set<string>;
  details?: boolean;
  stallMs?: number;
  log: (level: "info" | "warn" | "error", msg: string) => void;
  progress?: (p: { done: number; expected: number | null }) => void;
  /** Called with each batch of new orders as they're captured (write incrementally). */
  onOrders: (orders: Order[]) => Promise<void> | void;
};
export type CrawlResult = { emitted: number; expected: number | null; seenInRange: number; stoppedByLimit: boolean };

const ORDER_ID = new RegExp(QV.ordersPage.orderId);
const mmddyyyy = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type Card = { id: string; lines: string[]; itemLines: string[]; hasShowItems: boolean };
type XhrOrder = { ids: string[]; date?: string; total?: number; name?: string; phone?: string; email?: string; payment?: string; refunded?: boolean; items?: OrderItem[] };

export async function crawlOrders(portal: QuickveePortal, o: CrawlOptions): Promise<CrawlResult> {
  const page = portal.page;
  const seen = o.seen ?? new Set<string>();
  const stallMs = o.stallMs ?? 30_000;
  const xhr = new Map<string, XhrOrder>();
  let rawSaved = 0;
  const onResponse = async (res: import("playwright-core").Response) => {
    try {
      if (!/json/i.test(res.headers()["content-type"] ?? "") || res.request().resourceType() === "document") return;
      const body = await res.json();
      const found = extractXhrOrders(body);
      if (!found.length) return;
      for (const x of found) for (const id of x.ids) xhr.set(id, x);
      if (rawSaved < 3) { rawSaved++; await portal.snapshot(`orders-api-${rawSaved}.json`, JSON.stringify(body)); }
    } catch { /* not JSON / body gone: ignore */ }
  };
  page.on("response", onResponse);
  try {
    await portal.goto(QV.paths.orders);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await selectTab(portal, o.channel);
    const before = await bodyText(portal);
    await setDate(portal, QV.ordersPage.startDate, mmddyyyy(o.from), "Start Date");
    await setDate(portal, QV.ordersPage.endDate, mmddyyyy(o.to), "End Date");
    await waitForRefresh(portal, before);
    const expected = await readCount(portal);
    o.log("info", `${o.channel} ${o.from} → ${o.to}: portal shows ${expected ?? "?"} orders`);

    let emitted = 0, inRange = 0, lastNew = Date.now(), stoppedByLimit = false;
    const domIds = new Set<string>();
    while (true) {
      // Expand "Show Items" on unprocessed blocks, then read them.
      const clicked = await pageCall<number>(portal, "expand", { idRe: QV.ordersPage.orderId, show: QV.ordersPage.showItems.source, view: QV.ordersPage.viewDetails.source });
      if (clicked) await sleep(Math.min(1500, 200 + clicked * 20));
      const cards = await pageCall<Card[]>(portal, "read", { idRe: QV.ordersPage.orderId, view: QV.ordersPage.viewDetails.source, show: QV.ordersPage.showItems.source, hide: QV.ordersPage.hideItems.source });
      const batch: Order[] = [];
      for (const c of cards) {
        if (domIds.has(c.id)) continue;
        domIds.add(c.id); inRange++;
        if (seen.has(c.id)) continue;
        const order = toOrder(c, xhr.get(c.id), o.tz);
        if (!order) { o.log("warn", `Couldn't read order ${c.id} (no date); skipped`); continue; }
        if (o.details && (!order.customer.phone && !order.customer.email) && order.customer.name) Object.assign(order.customer, await readDetails(portal, c.id));
        seen.add(c.id); batch.push(order); emitted++;
        if (o.limit && emitted >= o.limit) { stoppedByLimit = true; break; }
      }
      if (batch.length) { await o.onOrders(batch); lastNew = Date.now(); }
      o.progress?.({ done: inRange, expected });
      if (stoppedByLimit) break;
      if (expected !== null && inRange >= expected) break;
      const grew = await scrollDown(portal);
      if (grew) lastNew = Date.now();
      if (Date.now() - lastNew > stallMs) {
        if (expected !== null && inRange < expected) o.log("warn", `Stopped after ${inRange} of ${expected} orders: the list stopped loading for ${Math.round(stallMs / 1000)}s`);
        break;
      }
    }
    // Orders the API returned that never rendered (rare): emit them too unless limited.
    if (!stoppedByLimit) {
      const extra: Order[] = [];
      for (const [id, x] of xhr) {
        if (domIds.has(id) || seen.has(id) || x.ids[0] !== id || !ORDER_ID.test(id)) continue;
        const order = xhrOnlyOrder(id, x, o.tz);
        if (!order || order.at.slice(0, 10) < o.from || order.at.slice(0, 10) > addDay(o.to)) continue;
        seen.add(id); extra.push(order); emitted++;
        if (o.limit && emitted >= o.limit) { stoppedByLimit = true; break; }
      }
      if (extra.length) await o.onOrders(extra);
    }
    if (expected !== null && !stoppedByLimit && inRange !== expected) o.log("warn", `${o.channel} ${o.from} → ${o.to}: read ${inRange} order blocks, portal said ${expected}`);
    return { emitted, expected, seenInRange: inRange, stoppedByLimit };
  } finally { page.off("response", onResponse); }
}

const addDay = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const bodyText = (p: QuickveePortal) => p.page.evaluate("document.body.innerText") as Promise<string>;

async function selectTab(p: QuickveePortal, channel: Channel) {
  const re = QV.ordersPage.tab(channel);
  const tab = p.page.getByRole("tab", { name: re }).or(p.page.getByRole("button", { name: re })).first();
  if (await tab.count()) { await tab.click(); await p.page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {}); }
  else if (channel === "online") throw new Error("Couldn't find the Online tab on Orders Management (selectors may need calibrating).");
}

/** Types MM/DD/YYYY into a date input; falls back to setting the value with input/change events when typing doesn't stick. */
async function setDate(p: QuickveePortal, f: { label: RegExp; css: string }, value: string, name: string) {
  const input = p.page.getByLabel(f.label).or(p.page.locator(f.css)).first();
  if (!(await input.count())) throw new Error(`Couldn't find the "${name}" input on Orders Management (selectors may need calibrating).`);
  await input.click();
  await input.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await input.pressSequentially(value, { delay: 30 });
  await input.press("Enter").catch(() => {});
  await input.press("Tab").catch(() => {});
  if ((await input.inputValue().catch(() => "")) !== value) {
    // Native setter + events: works for React-controlled inputs that ignore synthetic typing.
    await input.evaluate((el, v) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      (el as HTMLElement).blur();
    }, value);
  }
  if ((await input.inputValue().catch(() => "")) !== value) throw new Error(`The "${name}" input didn't accept ${value} (date picker may need calibrating).`);
  await p.throttle();
}

async function waitForRefresh(p: QuickveePortal, before: string) {
  const deadline = Date.now() + 20_000;
  await p.page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  while (Date.now() < deadline) {
    const now = await bodyText(p);
    if (now !== before && QV.ordersPage.showing.test(now)) break;
    await sleep(250);
  }
  // Then wait until the page settles (same text twice, 750 ms apart) so "Showing N" is the new range's count.
  let last = "";
  while (Date.now() < deadline + 10_000) {
    await p.page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
    const now = await bodyText(p);
    if (now === last) break;
    last = now;
    await sleep(750);
  }
}

async function readCount(p: QuickveePortal): Promise<number | null> {
  const m = QV.ordersPage.showing.exec(await bodyText(p));
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

const SCROLLABLE = `[...document.querySelectorAll("*")].filter(e => e.scrollHeight > e.clientHeight + 50 && /auto|scroll/.test(getComputedStyle(e).overflowY))`;
const HEIGHT = `document.documentElement.scrollHeight + ${SCROLLABLE}.reduce((s, e) => s + e.scrollHeight, 0)`;
const SCROLL = `(() => { window.scrollTo(0, document.documentElement.scrollHeight); for (const e of ${SCROLLABLE}) e.scrollTop = e.scrollHeight; })()`;

/** Scrolls the window and any scrollable container to the bottom; true when the page got taller (more loaded). */
async function scrollDown(p: QuickveePortal): Promise<boolean> {
  const h0 = Number(await p.page.evaluate(HEIGHT));
  await p.page.evaluate(SCROLL);
  await p.page.mouse.wheel(0, 2000).catch(() => {});
  await p.throttle();
  await p.page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
  const h1 = Number(await p.page.evaluate(HEIGHT));
  return h1 > h0;
}

// ---- In-page code: a plain JS string (transpilers can't inject helpers into it), installed as window.__pxo ----
const IN_PAGE = String.raw`(() => {
  if (window.__pxo) return;
  function findCards(idRe, view) {
    const re = new RegExp(idRe), viewRe = new RegExp(view, "i");
    const out = [], seen = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = (n.textContent || "").trim();
      if (!re.test(t)) continue;
      let el = n.parentElement;
      while (el && el !== document.body) {
        const btns = [...el.querySelectorAll("button, a, [role=button]")].filter(b => viewRe.test((b.innerText || "").trim()));
        if (btns.length > 1) { el = null; break; }
        if (btns.length === 1) break;
        el = el.parentElement;
      }
      if (el && el !== document.body && !seen.has(el)) { seen.add(el); out.push({ id: t, el }); }
    }
    return out;
  }
  window.__pxo = {
    expand(a) {
      const showRe = new RegExp(a.show, "i");
      let n = 0;
      for (const c of findCards(a.idRe, a.view)) {
        if (c.el.dataset.pxoExpanded) continue;
        c.el.dataset.pxoExpanded = "1";
        const b = [...c.el.querySelectorAll("button, a, [role=button]")].find(x => showRe.test((x.innerText || "").trim()));
        if (b) { b.click(); n++; }
      }
      return n;
    },
    read(a) {
      const showRe = new RegExp(a.show, "i"), hideRe = new RegExp(a.hide, "i"), viewRe = new RegExp(a.view, "i");
      return findCards(a.idRe, a.view).map(({ id, el }) => {
        const lines = (el.innerText || "").split("\n").map(s => s.trim()).filter(Boolean);
        const h = lines.findIndex(l => hideRe.test(l));
        const end = lines.findIndex((l, i) => i > h && viewRe.test(l));
        return { id, lines, itemLines: h >= 0 ? lines.slice(h + 1, end > h ? end : undefined) : [], hasShowItems: lines.some(l => showRe.test(l)) };
      });
    },
    open(a) {
      const viewRe = new RegExp(a.view, "i");
      const c = findCards(a.idRe, a.view).find(x => x.id === a.id);
      const b = c && [...c.el.querySelectorAll("button, a, [role=button]")].find(x => viewRe.test((x.innerText || "").trim()));
      if (b) b.click();
      return !!b;
    }
  };
})()`;
const pageCall = async <T>(p: QuickveePortal, fn: "expand" | "read" | "open", arg: Record<string, string>): Promise<T> => {
  await p.page.evaluate(IN_PAGE);
  return p.page.evaluate(`window.__pxo.${fn}(${JSON.stringify(arg)})`) as Promise<T>;
};

// ---- Parsing ----

const DATE_RE = /^(\d{1,2}\/\d{1,2}\/\d{4})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?\s*[AP]M))?$/i;
const MONEY_RE = /^-?\(?\$\s?[\d,]+(?:\.\d{1,2})?\)?$/;
const COUNT_RE = /^(\d+)\s+items?$/i;
const NOISE = /^(show items|hide items|view details|refund(ed)?|walk[-\s]?in customer|items?)$/i;

/** Line items from the expanded "Show Items" area: "Name" then "2 x $9.50" / "Qty: 2" / "$19.00" (line total) lines. */
export function parseItemLines(lines: string[]): OrderItem[] {
  const items: OrderItem[] = [];
  let cur: OrderItem | null = null;
  let lineTotal: number | null = null;
  const finish = () => {
    if (!cur) return;
    if (!cur.unitPriceCents && lineTotal !== null) cur.unitPriceCents = Math.round(Math.abs(lineTotal) / cur.quantity);
    items.push(cur); cur = null; lineTotal = null;
  };
  for (const l of lines) {
    const one = /^(\d+)\s*[x×]\s+(.+?)\s+(-?\$[\d,.]+)$/i.exec(l); // "2 x Name $9.50"
    if (one) { finish(); cur = { name: one[2], sku: null, category: null, brand: null, quantity: +one[1], unitPriceCents: Math.abs(toCents(one[3])), discountCents: 0 }; finish(); continue; }
    const qp = /^(?:qty:?\s*)?(\d+)\s*[x×@]\s*(-?\$[\d,.]+)$/i.exec(l); // "2 x $9.50"
    const q = /^(?:qty:?|quantity:?)\s*(\d+)$|^[x×]\s*(\d+)$/i.exec(l);
    const disc = /^(?:discount|disc\.?)[:\s]*-?\$?([\d,.]+)$/i.exec(l);
    if (cur && qp) { cur.quantity = Math.max(1, +qp[1]); cur.unitPriceCents = Math.abs(toCents(qp[2])); continue; }
    if (cur && q) { cur.quantity = Math.max(1, +(q[1] ?? q[2])); continue; }
    if (cur && disc) { cur.discountCents = Math.abs(toCents(disc[1])); continue; }
    if (cur && MONEY_RE.test(l)) { if (lineTotal === null) lineTotal = toCents(l); continue; }
    if (/^(sku|upc)[:\s]/i.test(l)) { if (cur) cur.sku = l.replace(/^(sku|upc)[:\s]*/i, "") || null; continue; }
    if (NOISE.test(l) || MONEY_RE.test(l)) continue;
    finish();
    cur = { name: l, sku: null, category: null, brand: null, quantity: 1, unitPriceCents: 0, discountCents: 0 };
  }
  finish();
  return items;
}

/** One order block (+ matching API record, if any) → Order. */
export function toOrder(c: Card, x: XhrOrder | undefined, tz: string): Order | null {
  const itemStart = c.lines.findIndex(l => QV.ordersPage.hideItems.test(l));
  const head = itemStart >= 0 ? c.lines.slice(0, itemStart) : c.lines;
  let date: string | undefined, total: number | null = null, count: number | null = null, payment: string | null = null;
  const names: string[] = [];
  for (let i = 0; i < head.length; i++) {
    const l = head[i];
    if (l === c.id || QV.ordersPage.showItems.test(l) || QV.ordersPage.viewDetails.test(l)) continue;
    const d = DATE_RE.exec(l);
    if (d && !date) { date = l; continue; }
    if (MONEY_RE.test(l)) { if (total === null) total = toCents(l); continue; }
    const n = COUNT_RE.exec(l);
    if (n) { count = +n[1]; const next = head[i + 1]; if (next && !QV.ordersPage.showItems.test(next) && !MONEY_RE.test(next)) { payment = next; i++; } continue; }
    if (/refund/i.test(l)) continue;
    names.push(l);
  }
  const at = toIso(date ?? x?.date, tz);
  if (!at) return null;
  const rawName = names[0] ?? x?.name ?? null;
  const name = rawName && !QV.ordersPage.walkIn.test(rawName) ? rawName : null;
  let items = parseItemLines(c.itemLines);
  if (!items.length && x?.items?.length) items = x.items;
  else if (x?.items?.length) items = items.map(i => { // enrich from the API record (SKU/category/brand aren't on the card)
    const m = x.items!.find(y => y.name.toLowerCase() === i.name.toLowerCase());
    return m ? { ...i, sku: i.sku ?? m.sku, category: m.category, brand: m.brand, discountCents: i.discountCents || m.discountCents } : i;
  });
  const totalCents = total ?? x?.total ?? items.reduce((s, i) => s + i.quantity * i.unitPriceCents - i.discountCents, 0);
  const subtotalCents = items.length ? items.reduce((s, i) => s + i.quantity * i.unitPriceCents, 0) : totalCents;
  const refunded = c.lines.some(l => /^refund(ed)?$/i.test(l)) || x?.refunded === true || totalCents < 0;
  void count;
  return {
    externalId: c.id, at,
    customer: { externalId: null, name, phone: normalizePhone(x?.phone), email: normalizeEmail(x?.email) },
    items, subtotalCents, discountCents: items.length ? Math.max(0, subtotalCents - items.reduce((s, i) => s + i.discountCents, 0) - Math.abs(totalCents)) : 0,
    totalCents, paymentMethod: payment ?? x?.payment ?? null, ...(refunded ? { refunded: true } : {})
  };
}

function xhrOnlyOrder(id: string, x: XhrOrder, tz: string): Order | null {
  return toOrder({ id, lines: [], itemLines: [], hasShowItems: false }, x, tz);
}

/** Loose match of order-like objects anywhere in a JSON body. Money in dollars unless the key says cents. */
export function extractXhrOrders(body: unknown): XhrOrder[] {
  const out: XhrOrder[] = [];
  const pick = (o: Record<string, unknown>, re: RegExp) => { for (const [k, v] of Object.entries(o)) if (re.test(k) && v !== null && v !== undefined && v !== "") return [k, v] as const; return undefined; };
  const money = (kv: readonly [string, unknown] | undefined) => {
    if (!kv) return undefined;
    const [k, v] = kv;
    if (typeof v === "number") return /cents/i.test(k) ? Math.round(v) : Math.round(v * 100);
    return typeof v === "string" ? toCents(v) : undefined;
  };
  const visit = (v: unknown, depth: number) => {
    if (depth > 6 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) { for (const e of v) visit(e, depth + 1); return; }
    const o = v as Record<string, unknown>;
    const ids = Object.values(o).filter((x): x is string => typeof x === "string" && ORDER_ID.test(x.trim())).map(s => s.trim());
    const date = pick(o, /date|time|created/i);
    const total = pick(o, /^(grand_?)?total|amount|order_?total/i);
    if (ids.length && date && total) {
      const itemsKv = pick(o, /items|products|line/i);
      const items = Array.isArray(itemsKv?.[1]) ? (itemsKv![1] as Record<string, unknown>[]).filter(i => i && typeof i === "object").map(i => ({
        name: String(pick(i, /name|title|product/i)?.[1] ?? "Item"), sku: (pick(i, /sku|upc/i)?.[1] as string) ?? null, category: (pick(i, /categ/i)?.[1] as string) ?? null,
        brand: (pick(i, /brand|vendor/i)?.[1] as string) ?? null, quantity: Math.max(1, Math.round(Number(pick(i, /qty|quantity/i)?.[1] ?? 1)) || 1),
        unitPriceCents: Math.abs(money(pick(i, /price|amount|rate/i)) ?? 0), discountCents: Math.abs(money(pick(i, /discount/i)) ?? 0)
      })) : undefined;
      const status = String(pick(o, /status|type/i)?.[1] ?? "");
      out.push({ ids, date: String(date[1]), total: money(total), name: pick(o, /customer_?name|^customer$|^name$/i)?.[1] as string | undefined,
        phone: pick(o, /phone|mobile/i)?.[1] as string | undefined, email: pick(o, /email/i)?.[1] as string | undefined,
        payment: pick(o, /payment|tender/i)?.[1] as string | undefined, refunded: /refund/i.test(status) || pick(o, /refund/i)?.[1] === true, items });
    }
    for (const x of Object.values(o)) if (x && typeof x === "object") visit(x, depth + 1);
  };
  visit(body, 0);
  return out;
}

/** --details: opens "View Details" for one order and reads a phone/email from whatever opens, then goes back. */
async function readDetails(p: QuickveePortal, id: string): Promise<{ phone?: string | null; email?: string | null }> {
  const url = p.page.url();
  const before = await bodyText(p);
  if (!(await pageCall<boolean>(p, "open", { idRe: QV.ordersPage.orderId, view: QV.ordersPage.viewDetails.source, id }))) return {};
  await p.throttle();
  await p.page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  const text = await bodyText(p);
  const added = text.length > before.length ? text : text;
  const email = normalizeEmail(/[^\s@]+@[^\s@]+\.[a-z]{2,}/i.exec(added)?.[0]);
  const phone = normalizePhone(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/.exec(added)?.[0]);
  if (p.page.url() !== url) { await p.page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {}); }
  else {
    const close = p.page.getByRole("button", { name: /^(close|×|x|back)$/i }).first();
    if (await close.count()) await close.click().catch(() => {}); else await p.page.keyboard.press("Escape");
  }
  return { phone, email };
}
