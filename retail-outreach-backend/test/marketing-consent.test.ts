import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeApp } from "./helpers.js";
import type { SuggestionInput, SuggestionProvider } from "../src/providers/ai.js";
import { RulesSuggestionProvider } from "../src/providers/ai.js";
import { MemoryStore } from "../src/store/memory.js";
import { DEMO_ORG_ID, DEMO_USER_ID } from "../src/data/seed.js";
import { IN_STORE_SIGNUP } from "../src/customers/csvImport.js";

function countingAi(): SuggestionProvider & { calls: number } {
  const rules = new RulesSuggestionProvider();
  const p: SuggestionProvider & { calls: number } = {
    name: "openai", calls: 0,
    async suggest(input: SuggestionInput) {
      p.calls++;
      return { ...(await rules.suggest(input)), source: "openai", model: "gpt-4o-mini", usage: { inputTokens: 10, outputTokens: 5 } };
    }
  };
  return p;
}

let app: FastifyInstance;
afterEach(async () => { await app?.close(); });

describe("marketing consent gates the deck and AI", () => {
  it("excludes customers with no opt-in from the deck and makes no AI call for them", async () => {
    const store = new MemoryStore();
    const ai = countingAi();
    ({ app } = await makeApp({ store, suggestions: ai }));
    const actor = { userId: DEMO_USER_ID, orgId: DEMO_ORG_ID };
    // Seed a no-consent customer with an open opportunity (as order-import used to).
    await store.importCustomers(actor, [{
      row: 1, externalId: "no-consent-1", firstName: "NoConsent", lastName: "Person", phone: "+15555559999", email: "noc@example.com",
      location: null, age: 30, lastPurchaseAt: null, lifetimeSpendCents: 0, rewardsPoints: null, lifetimeOrders: null, customerSince: null
    }], { smsConsent: false, emailConsent: false, ageVerified: true });

    const q = (await app.inject("/api/outreach/queue?limit=50")).json();
    expect(q.items.find((i: any) => i.customer.firstName === "NoConsent")).toBeUndefined();

    const prep = await app.inject({ method: "POST", url: "/api/outreach/deck/prepare", payload: { limit: 50 } });
    expect(prep.statusCode).toBe(200);
    // Prepare only walks the deck — no-consent never reaches AI.
    const before = ai.calls;
    const mine = (await store.listCustomers(actor, { search: "NoConsent", limit: 10, offset: 0 })).items[0];
    const open = await app.inject({ method: "POST", url: `/api/customers/${mine.id}/open`, payload: {} });
    expect(open.statusCode).toBe(403);
    expect(open.json()).toMatchObject({ code: "no_marketing_consent" });
    expect(ai.calls).toBe(before);
  });

  it("includes CSV-imported customers (import_signup opt-ins) and allows AI", async () => {
    const store = new MemoryStore();
    const ai = countingAi();
    ({ app } = await makeApp({ store, suggestions: ai }));
    const actor = { userId: DEMO_USER_ID, orgId: DEMO_ORG_ID };
    await store.importCustomers(actor, [{
      row: 1, externalId: null, firstName: "CsvIn", lastName: "Customer", phone: "+15555558888", email: "csv@example.com",
      location: null, age: 28, lastPurchaseAt: null, lifetimeSpendCents: 0, rewardsPoints: null, lifetimeOrders: null, customerSince: null
    }], IN_STORE_SIGNUP);

    const q = (await app.inject("/api/outreach/queue?limit=50")).json();
    const card = q.items.find((i: any) => i.customer.firstName === "CsvIn");
    expect(card).toBeTruthy();
    expect(card.customer.contact).toMatchObject({ sms: true, email: true });

    const s = await app.inject({ method: "POST", url: `/api/outreach/${card.id}/suggestion`, payload: { channel: "sms" } });
    expect(s.statusCode).toBe(200);
    expect(ai.calls).toBe(1);
  });

  it("opted out of one channel still offers the other; AI only for the consented channel", async () => {
    const ai = countingAi();
    ({ app } = await makeApp({ suggestions: ai }));
    // Sarah (opp_0001) has both; opt out of SMS.
    const out = await app.inject({ method: "POST", url: "/api/outreach/opp_0001/opt-out", payload: { channel: "sms" } });
    expect(out.statusCode).toBeLessThan(300);

    const card = (await app.inject("/api/outreach/opp_0001")).json();
    expect(card.customer.contact).toMatchObject({ sms: false, email: true });

    expect((await app.inject({ method: "POST", url: "/api/outreach/opp_0001/suggestion", payload: { channel: "sms" } })).statusCode).toBe(422);
    const email = await app.inject({ method: "POST", url: "/api/outreach/opp_0001/suggestion", payload: { channel: "email" } });
    expect(email.statusCode).toBe(200);
    expect(ai.calls).toBe(1);

    // Still in the deck via email.
    const q = (await app.inject("/api/outreach/queue?limit=50")).json();
    expect(q.items.map((i: any) => i.id)).toContain("opp_0001");
  });
});
