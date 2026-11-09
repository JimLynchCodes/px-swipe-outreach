import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeApp } from "./helpers.js";
import { ordersToCsv, parseOrderCsv } from "../src/orders/csvImport.js";
import { ImportError } from "../src/customers/csvImport.js";

const CSV = readFileSync(new URL("./fixtures/orders-import.csv", import.meta.url), "utf8");
let app: FastifyInstance;
afterEach(async () => { await app?.close(); });
const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, payload: payload as any });

describe("order CSV parsing", () => {
  const p = parseOrderCsv(CSV);
  it("groups line items into orders", () => {
    expect(p.orders.map(o => o.externalId)).toEqual(["A-1001", "A-1002", "A-1003"]);
    expect(p.orders[0]).toMatchObject({ totalCents: 3852, customer: { name: "Jamal Carter", phone: "+15555550002" } });
    expect(p.orders[0].items.map(i => [i.name, i.quantity, i.unitPriceCents])).toEqual([["Padrón 1964 Maduro", 2, 1800], ["Cutter", 1, 999]]);
    expect(p.orders[1]).toMatchObject({ discountCents: 500, totalCents: 99500, paymentMethod: "Cash", customer: { externalId: "900111", email: "riley@example.com" } });
  });
  it("reports invalid rows", () => {
    expect(p.invalid).toEqual([{ row: 5, reason: "Missing order ID" }, { row: 6, reason: 'Invalid date "not a date"' }]);
    expect(() => parseOrderCsv("Name,Phone\nA,1")).toThrow(/Order ID/);
    expect(() => parseOrderCsv("")).toThrow(ImportError);
  });
  it("round-trips through the scraper's CSV writer", () => {
    const again = parseOrderCsv(ordersToCsv(p.orders));
    expect(again.orders).toEqual(p.orders);
    expect(again.invalid).toEqual([]);
  });
});

describe("order import API", () => {
  it("previews new orders with customer links, imports, dedupes by order id, feeds purchase history", async () => {
    ({ app } = await makeApp());
    const pre = (await post("/api/orders/import/preview", { csv: CSV })).json();
    expect(pre.newOrders.map((o: any) => [o.orderId, o.link])).toEqual([["A-1003", "unlinked"], ["A-1002", "new"], ["A-1001", "existing"]]);
    expect(pre).toMatchObject({ newOrderCount: 3, existing: 0, links: { existing: 1, new: 1, unlinked: 1 }, totalCents: 3852 + 99500 });
    expect(pre.invalid).toHaveLength(2);

    const imp = await post("/api/orders/import", { csv: CSV });
    expect(imp.statusCode).toBe(201);
    expect(imp.json()).toMatchObject({ inserted: 2, existing: 0, customersCreated: 1, unlinked: 1, invalid: 2 });
    expect((await post("/api/orders/import/preview", { csv: CSV })).json()).toMatchObject({ newOrderCount: 1, existing: 2 });
    expect((await post("/api/orders/import", { csv: CSV })).json()).toMatchObject({ inserted: 0, existing: 2, unlinked: 1 });

    const jamal = (await app.inject("/api/outreach/opp_0002")).json();
    expect(jamal.lastPurchase).toMatchObject({ name: "Padrón 1964 Maduro" });
    const riley = (await app.inject("/api/customers?search=riley")).json().items[0];
    expect(riley).toMatchObject({ name: "Riley Newcomer", source: "csv" });
    // Order-history import does not grant marketing consent — not in the deck, open is blocked.
    const open = await post(`/api/customers/${riley.id}/open`, {});
    expect(open.statusCode).toBe(403);
    expect(open.json()).toMatchObject({ code: "no_marketing_consent" });
    const deck = (await app.inject("/api/outreach/queue?limit=100")).json();
    expect(deck.items.find((i: any) => i.customer.firstName === "Riley")).toBeUndefined();
  });

  it("errors gracefully", async () => {
    ({ app } = await makeApp());
    expect((await post("/api/orders/import/preview", { csv: "Name\nx" })).json()).toMatchObject({ code: "invalid_csv" });
    expect((await post("/api/orders/import", { csv: "Order ID,Date\n,\n" })).json()).toMatchObject({ code: "nothing_to_import" });
  });
});

describe("order_total_paid column", () => {
  const paidCsv = readFileSync(new URL("./fixtures/orders-total-paid.csv", import.meta.url), "utf8");
  it("reads order_total_paid (currency / case / whitespace) as amount spent; does not sum line items", () => {
    const p = parseOrderCsv(paidCsv);
    expect(p.invalid).toEqual([]);
    expect(p.orders).toHaveLength(2);
    // $1,234.50 — not 50*2 + 999
    expect(p.orders[0]).toMatchObject({ externalId: "B-2001", totalCents: 123450 });
    expect(p.orders[0].items).toHaveLength(2);
    expect(p.orders[1]).toMatchObject({ externalId: "B-2002", totalCents: 4200 });
  });
  it("accepts Total and ORDER TOTAL PAID header variants", () => {
    const alt = "Order ID,Date,Phone,Item,Qty,Unit price,ORDER TOTAL PAID\nC-1,2026-11-07,+16095552003,X,1,5.00,\"$9.99\"\n";
    expect(parseOrderCsv(alt).orders[0].totalCents).toBe(999);
    const spaced = "Order ID,Date,Phone,Item, order_total_paid \nC-2,2026-11-07,+16095552004,Y, $12.00 \n";
    expect(parseOrderCsv(spaced).orders[0].totalCents).toBe(1200);
  });
  it("import updates lifetime spend from order_total_paid", async () => {
    ({ app } = await makeApp());
    const imp = await post("/api/orders/import", { csv: paidCsv });
    expect(imp.statusCode).toBe(201);
    expect(imp.json()).toMatchObject({ inserted: 2, customersCreated: 2 });
    const sam = (await app.inject("/api/customers?search=sam")).json().items[0];
    expect(sam.lifetimeSpendCents).toBe(123450);
    const pat = (await app.inject("/api/customers?search=pat")).json().items[0];
    expect(pat.lifetimeSpendCents).toBe(4200);
  });
});

describe("order import progress stream", () => {
  it("streams NDJSON progress then done when Accept is application/x-ndjson", async () => {
    ({ app } = await makeApp());
    const csv = readFileSync(new URL("./fixtures/orders-total-paid.csv", import.meta.url), "utf8");
    const res = await app.inject({
      method: "POST", url: "/api/orders/import",
      headers: { accept: "application/x-ndjson", "content-type": "application/json" },
      payload: { csv },
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"] ?? "")).toMatch(/ndjson/);
    const lines = res.body.trim().split("\n").map(l => JSON.parse(l));
    expect(lines.some((l: any) => l.type === "progress" && l.phase === "writing")).toBe(true);
    const done = lines.find((l: any) => l.type === "done");
    expect(done).toMatchObject({ inserted: 2, customersCreated: 2 });
  });
});
