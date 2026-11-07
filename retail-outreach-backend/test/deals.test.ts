import { DEMO_SETTINGS } from "../src/data/seed.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { MemoryStore } from "../src/store/memory.js";
import { DEMO_ORG_ID, DEMO_ORG } from "../src/data/seed.js";
import { fakeSupabase, makeApp } from "./helpers.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const STAFF = "33333333-3333-4333-8333-333333333333";
const OUTSIDER = "55555555-5555-4555-8555-555555555555";
const OTHER_ORG = "99999999-9999-4999-8999-999999999999";

let app: FastifyInstance;
let sign: (sub: string) => Promise<string>;
beforeEach(async () => {
  const store = new MemoryStore();
  const org = { orgId: DEMO_ORG_ID, orgName: DEMO_ORG.name, businessName: DEMO_ORG.businessName };
  store.addMembership(OWNER, { ...org, role: "owner" });
  store.addMembership(STAFF, { ...org, role: "staff" });
  store.addMembership(OUTSIDER, { orgId: OTHER_ORG, orgName: "Other", businessName: null, role: "owner" });
  const fake = await fakeSupabase();
  sign = s => fake.sign(s);
  ({ app } = await makeApp({ store, authenticator: fake.authenticator }));
  // Seasonal seed promotions are dated relative to today; drop them so suggestion assertions don't depend on the date.
  for (const d of (await as(OWNER, "GET", "/api/deals")).json().deals) if (d.schedule === "range") await as(OWNER, "DELETE", `/api/deals/${d.id}`);
});
afterEach(async () => { await app?.close(); });

async function as(user: string, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown, orgId = DEMO_ORG_ID) {
  return app.inject({ method, url, payload: payload as any, headers: { authorization: `Bearer ${await sign(user)}`, "x-org-id": orgId } });
}
const deal = { days: [3, 1], title: "Late-night glass", description: "10% off glass after 8pm", discountType: "percent", discountValue: 10,
  categories: ["Glass"], productIds: ["prod_spoon"], startsOn: "2026-11-01", endsOn: "2026-12-31", active: true };

describe("promotions (deals)", () => {
  it("lists seeded promotions to every member, scoped by org", async () => {
    const r = await as(STAFF, "GET", "/api/deals");
    expect(r.statusCode).toBe(200);
    const titles = r.json().deals.map((d: any) => d.title);
    expect(titles).toEqual(expect.arrayContaining(["Mellow Monday", "Cigar Friday", "Holiday Glass Sale"]));
    expect((await as(OUTSIDER, "GET", "/api/deals", undefined, OTHER_ORG)).json().deals).toEqual([]);
    expect((await as(OUTSIDER, "GET", "/api/deals")).statusCode).toBe(403);
  });

  it("owners create, update, toggle and delete; input is normalized", async () => {
    const created = await as(OWNER, "POST", "/api/deals", deal);
    expect(created.statusCode).toBe(201);
    const d = created.json().deal;
    expect(d).toMatchObject({ days: [1, 3], categories: ["glass"], productIds: ["prod_spoon"], active: true });
    const off = await as(OWNER, "PUT", `/api/deals/${d.id}`, { ...deal, active: false });
    expect(off.json().deal.active).toBe(false);
    expect((await as(OWNER, "DELETE", `/api/deals/${d.id}`)).statusCode).toBe(200);
    expect((await as(OWNER, "DELETE", `/api/deals/${d.id}`)).statusCode).toBe(404);
  });

  it("date-range promotions need both dates and run every day", async () => {
    const range = { ...deal, schedule: "range", days: [], startsOn: "2026-11-20", endsOn: "2026-12-31" };
    const r = await as(OWNER, "POST", "/api/deals", range);
    expect(r.statusCode).toBe(201);
    expect(r.json().deal).toMatchObject({ schedule: "range", days: [0, 1, 2, 3, 4, 5, 6], startsOn: "2026-11-20", endsOn: "2026-12-31" });
    const noEnd = await as(OWNER, "POST", "/api/deals", { ...range, endsOn: null });
    expect(noEnd.statusCode).toBe(400);
    expect(noEnd.json().details.join(" ")).toContain("endsOn");
    expect((await as(OWNER, "POST", "/api/deals", { ...range, schedule: "monthly" })).statusCode).toBe(400);
    // weekly stays the default
    expect((await as(OWNER, "POST", "/api/deals", deal)).json().deal.schedule).toBe("weekly");
  });

  it("staff cannot edit promotions", async () => {
    const r = await as(STAFF, "POST", "/api/deals", deal);
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe("insufficient_role");
  });

  it.each([
    [{ ...deal, days: [] }, "days"],
    [{ ...deal, days: [7] }, "days"],
    [{ ...deal, discountValue: 150 }, "discountValue"],
    [{ ...deal, discountType: "bogo" }, "discountValue"],
    [{ ...deal, endsOn: "2026-10-01" }, "endsOn"],
    [{ ...deal, productIds: ["nope"] }, "productIds"],
    [{ ...deal, title: "" }, "title"],
    [{ ...deal, extra: 1 }, "body"]
  ])("rejects invalid input %#", async (body, field) => {
    const r = await as(OWNER, "POST", "/api/deals", body);
    expect(r.statusCode).toBe(400);
    expect(r.json().details.join(" ")).toContain(field);
  });

  it("disabling a promotion changes the suggestion", async () => {
    const jamal = "opp_0002";
    const before = (await as(OWNER, "POST", `/api/outreach/${jamal}/suggestion`, { channel: "sms" })).json().suggestion;
    expect(before.deal.title).toBe("Cigar Friday");
    const cigar = (await as(OWNER, "GET", "/api/deals")).json().deals.find((d: any) => d.title === "Cigar Friday");
    const { id, orgId: _o, createdAt: _c, updatedAt: _u, ...input } = cigar;
    await as(OWNER, "PUT", `/api/deals/${id}`, { ...input, active: false });
    const after = (await as(OWNER, "POST", `/api/outreach/${jamal}/suggestion`, { channel: "sms" })).json().suggestion;
    expect(after.deal).toBeNull();
    expect(after.title).toBe("Thank them with 20% off");
  });

  it("serves the catalog with categories", async () => {
    const r = (await as(STAFF, "GET", "/api/catalog")).json();
    expect(r.categories).toEqual(["accessories", "cbd", "cigars", "glass", "hookah", "papers", "vape"]);
    expect(r.products.find((p: any) => p.id === "prod_padron")).toMatchObject({ brand: "Padrón", category: "cigars" });
  });
});

describe("settings", () => {
  const settings = { storeName: "Cloud Nine", emailSignature: "Cloud Nine\r\nMain St", smsSignature: "-C9", defaultChannel: "email", maxDiscountPercent: 10 };

  it("returns seeded settings and lets owners update them", async () => {
    expect((await as(STAFF, "GET", "/api/settings")).json().settings).toMatchObject({ storeName: "Cloud 9 Smoke Shop", smsSignature: "-Cloud 9", maxDiscountPercent: 25 });
    const r = await as(OWNER, "PUT", "/api/settings", settings);
    expect(r.statusCode).toBe(200);
    expect(r.json().settings).toEqual({ ...settings, emailSignature: "Cloud Nine\nMain St", aiModel: "openai/gpt-4o-mini", brandVoice: DEMO_SETTINGS.brandVoice, smsCooldownDays: 0, emailCooldownDays: 0 });
    const voice = { preset: "chill", emoji: true, signOff: "Stay chill", about: "Neighborhood shop" };
    expect((await as(OWNER, "PUT", "/api/settings", { ...settings, brandVoice: voice })).json().settings.brandVoice).toEqual(voice);
    for (const bad of [{ ...voice, preset: "edgy" }, { ...voice, about: "x".repeat(501) }, { ...voice, signOff: "a\nb" }]) {
      expect((await as(OWNER, "PUT", "/api/settings", { ...settings, brandVoice: bad })).statusCode).toBe(400);
    }
    expect((await as(STAFF, "PUT", "/api/settings", settings)).statusCode).toBe(403);
    expect((await as(OUTSIDER, "GET", "/api/settings", undefined, OTHER_ORG)).json().settings).toMatchObject({ storeName: null, smsSignature: "" });
  });

  it("rejects multi-line or long SMS signatures and bad caps", async () => {
    for (const bad of [{ smsSignature: "a\nb" }, { smsSignature: "x".repeat(61) }, { maxDiscountPercent: 101 }, { defaultChannel: "fax" }]) {
      expect((await as(OWNER, "PUT", "/api/settings", { ...settings, ...bad })).statusCode).toBe(400);
    }
  });

  it("store name, signatures and discount cap shape the generated messages", async () => {
    await as(OWNER, "PUT", "/api/settings", settings);
    const sms = (await as(OWNER, "POST", "/api/outreach/opp_0002/suggestion", { channel: "sms" })).json().suggestion;
    // Cigar Friday (20%) is above the 10% cap → standing VIP offer, capped to 10%
    expect(sms.deal).toBeNull();
    expect(sms.message).toMatch(/^Hi Jamal, it's Cloud Nine! Here's 10% off your next visit.* -C9\nReply STOP to opt out\.$/s);
    const email = (await as(OWNER, "POST", "/api/outreach/opp_0002/suggestion", { channel: "email" })).json().suggestion;
    expect(email.message).toContain("Cloud Nine\nMain St");
    expect(email.message).not.toContain("-C9");
  });
});
