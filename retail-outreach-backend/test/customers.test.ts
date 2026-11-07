import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeApp } from "./helpers.js";
import { parseCustomerCsv, ImportError } from "../src/customers/csvImport.js";

const CSV = readFileSync(new URL("./fixtures/customers-import.csv", import.meta.url), "utf8");
let app: FastifyInstance;
afterEach(async () => { await app?.close(); });
const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, payload: payload as any });

describe("customer CSV parsing (Quickvee export columns)", () => {
  const p = parseCustomerCsv(CSV, { now: Date.parse("2026-11-07T12:00:00Z") });
  it("maps columns and splits full names in 'First name'", () => {
    expect(p.customers.map(c => [c.firstName, c.lastName])).toEqual([["Avery", "Testwood"], ["Blake", ""], ["Jamal", "Carter"]]);
    expect(p.customers[0]).toMatchObject({ externalId: "900001", phone: "+16095550101", email: "avery.test@example.com", location: "Burlington",
      lifetimeSpendCents: 129424, rewardsPoints: 43, customerSince: "2025-05-12", age: null });
    expect(p.customers[1]).toMatchObject({ phone: "+16095550102", age: 36 });
    expect(p.customers[0].lastPurchaseAt).toMatch(/^2026-09-19/);
  });
  it("reports invalid rows with reasons and drops in-file duplicates", () => {
    expect(p.invalid).toEqual([
      { row: 4, reason: "Invalid phone and email" }, { row: 5, reason: "Disabled in POS" }, { row: 6, reason: "Missing name" }
    ]);
    expect(p.duplicatesInFile).toBe(1);
  });
  it("rejects files it can't use", () => {
    expect(() => parseCustomerCsv("")).toThrow(ImportError);
    expect(() => parseCustomerCsv("Name,Notes\nA,b")).toThrow(/Phone or Email/);
    expect(() => parseCustomerCsv('Name,Phone\n"unterminated,6095550101')).toThrow(ImportError);
  });
});

describe("customer import API", () => {
  it("previews only new customers (deduped against the store), then imports them", async () => {
    ({ app } = await makeApp());
    const pre = await post("/api/customers/import/preview", { csv: CSV });
    expect(pre.statusCode).toBe(200);
    const body = pre.json();
    expect(body.newCustomers.map((c: any) => c.name)).toEqual(["Avery Testwood", "Blake"]);
    expect(body).toMatchObject({ existing: 1, duplicatesInFile: 1, totalRows: 7 });
    expect(body.invalid).toHaveLength(3);
    expect(JSON.stringify(body)).not.toContain("6095550101"); // masked

    const before = (await app.inject("/api/outreach/queue?limit=100")).json().total;
    const imp = await post("/api/customers/import", { csv: CSV, smsConsent: true, emailConsent: true, ageVerified: true });
    expect(imp.statusCode).toBe(201);
    expect(imp.json()).toMatchObject({ inserted: 2, existing: 1, invalid: 3 });
    expect((await app.inject("/api/outreach/queue?limit=100")).json().total).toBe(before + 2);
    // Re-uploading the same file adds nobody.
    expect((await post("/api/customers/import/preview", { csv: CSV })).json().newCustomers).toEqual([]);
    expect((await post("/api/customers/import", { csv: CSV })).json()).toMatchObject({ inserted: 0, existing: 3 });

    const list = (await app.inject("/api/customers?search=avery")).json();
    expect(list.items).toEqual([expect.objectContaining({ name: "Avery Testwood", source: "csv", phone: expect.stringContaining("***") })]);
  });

  it("imported customers without consent can't be contacted", async () => {
    ({ app } = await makeApp());
    await post("/api/customers/import", { csv: CSV });
    const id = (await app.inject("/api/customers?search=blake")).json().items[0].id;
    const opp = (await post(`/api/customers/${id}/open`, {})).json().opportunityId;
    const card = (await app.inject(`/api/outreach/${opp}`)).json();
    expect(card.customer.contact).toMatchObject({ sms: false, email: false });
  });

  it("validates input and errors gracefully", async () => {
    ({ app } = await makeApp());
    expect((await post("/api/customers/import/preview", { csv: "" })).statusCode).toBe(400);
    const bad = await post("/api/customers/import/preview", { csv: "Name,Notes\nA,b" });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ code: "invalid_csv" });
    expect((await post("/api/customers/import", { csv: "Name,Phone\nA,123" })).json()).toMatchObject({ code: "nothing_to_import" });
    expect((await post("/api/customers/nope/open", {})).statusCode).toBe(404);
  });

  it("an explicit pick opens the card even inside the cooldown window", async () => {
    ({ app } = await makeApp());
    const { settings } = (await app.inject("/api/settings")).json();
    await app.inject({ method: "PUT", url: "/api/settings", payload: { ...settings, smsCooldownDays: 7, emailCooldownDays: 60 } });
    // Jamal (texted 3d ago, emailed 40d ago) is out of the deck…
    expect((await app.inject("/api/outreach/queue?limit=100")).json().items.map((i: any) => i.id)).not.toContain("opp_0002");
    const jamal = (await app.inject("/api/customers?search=jamal")).json().items[0];
    const { opportunityId } = (await post(`/api/customers/${jamal.id}/open`, {})).json();
    expect(opportunityId).toBe("opp_0002");
    const card = (await app.inject(`/api/outreach/${opportunityId}?pick=1`)).json();
    expect(card.customer.contact).toMatchObject({ sms: true, email: true });
    expect(card.customer.contact.cooldownUntil.sms).toEqual(expect.any(String));
    expect((await post(`/api/outreach/${opportunityId}/suggestion`, { channel: "sms" })).statusCode).toBe(422);
    expect((await post(`/api/outreach/${opportunityId}/suggestion`, { channel: "sms", ignoreCooldown: true })).statusCode).toBe(200);
  });

  it("picking a customer whose card was already used creates a fresh one", async () => {
    ({ app } = await makeApp());
    await post("/api/outreach/opp_0001/skip", {});
    const sarah = (await app.inject("/api/customers?search=sarah")).json().items[0];
    const { opportunityId } = (await post(`/api/customers/${sarah.id}/open`, {})).json();
    expect(opportunityId).not.toBe("opp_0001");
    expect((await app.inject(`/api/outreach/${opportunityId}`)).json().customer.firstName).toBe("Sarah");
  });
});
