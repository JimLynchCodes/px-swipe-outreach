import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeApp } from "./helpers.js";
import { createSuggestionProvider, type ChatCompletionClient } from "../src/providers/ai.js";
import { greetName } from "../src/providers/ai.js";
import { MemoryStore } from "../src/store/memory.js";
import { DEMO_ORG_ID, DEMO_USER_ID } from "../src/data/seed.js";
import { IN_STORE_SIGNUP } from "../src/customers/csvImport.js";

let app: FastifyInstance;
afterEach(async () => { await app?.close(); });

/** Stub that returns a personalized, compliance-clean draft from the user payload. */
function personalizedClient(): ChatCompletionClient & { calls: number } {
  const cl: ChatCompletionClient & { calls: number } = {
    calls: 0,
    async create(params) {
      cl.calls++;
      const user = JSON.parse(String((params.messages as { role: string; content: unknown }[]).find(m => m.role === "user")?.content ?? "{}"));
      const name = user.customer?.first_name || "friend";
      const dealId = user.engine_suggestion?.promotion_id ?? user.promotions?.[0]?.id ?? null;
      const promo = (user.promotions as { id: string; title: string; discount: string }[] | undefined)?.find(p => p.id === dealId)
        ?? (user.promotions as { id: string; title: string; discount: string }[] | undefined)?.[0];
      const title = promo?.title ?? "this week";
      const discount = promo?.discount ?? "10% off";
      const body = {
        promotion_id: promo?.id ?? null, reason: `Personalized for ${name}: ${title}`, send_time: "Friday afternoon",
        sms_text: `Hi ${name}, ${title} is on: ${discount}. See you soon. 21+ w/ ID.`,
        email_subject: `${title} for ${name}`.slice(0, 50),
        email_body: `Hi ${name},\n\n${title}: ${discount}.\n\nSee you soon.`,
        confidence: 0.9
      };
      return {
        id: `gen-${cl.calls}`,
        choices: [{ message: { content: JSON.stringify(body) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 200, completion_tokens: 80, cost: 0.0001 }
      };
    }
  };
  return cl;
}

describe("greetName", () => {
  it("rejects blanks and placeholders", () => {
    expect(greetName("Jamal")).toBe("Jamal");
    expect(greetName("")).toBeNull();
    expect(greetName("____")).toBeNull();
    expect(greetName("...")).toBeNull();
    expect(greetName("Customer")).toBeNull();
  });
});

describe("personalized AI suggestions (no silent shared template)", () => {
  it("stubbed realistic model responses yield distinct messages for 3 customers; no template fallback", async () => {
    const store = new MemoryStore();
    const client = personalizedClient();
    const suggestions = createSuggestionProvider({
      openrouterKey: "sk-or-test", openrouter: { client, maxRetries: 0 }
    });
    ({ app } = await makeApp({ store, suggestions }));

    const actor = { userId: DEMO_USER_ID, orgId: DEMO_ORG_ID };
    const names = ["PersAva", "PersBen", "PersCara"] as const;
    const ids: string[] = [];
    for (const n of names) {
      await store.importCustomers(actor, [{
        row: 1, externalId: null, firstName: n, lastName: "Test", phone: `+1609555${["101","102","103"][names.indexOf(n)]}`, email: `${n.toLowerCase()}.pers@example.com`,
        location: null, age: 30, lastPurchaseAt: null, lifetimeSpendCents: 0, rewardsPoints: null, lifetimeOrders: null, customerSince: null
      }], IN_STORE_SIGNUP);
      const q = (await app.inject("/api/outreach/queue?limit=50")).json();
      const card = q.items.find((i: any) => i.customer.firstName === n);
      expect(card).toBeTruthy();
      ids.push(card.id);
    }

    const messages: string[] = [];
    for (const id of ids) {
      const r = await app.inject({ method: "POST", url: `/api/outreach/${id}/suggestion`, payload: { channel: "sms", refresh: true } });
      expect(r.statusCode).toBe(200);
      const s = r.json().suggestion;
      expect(s.template).toBeFalsy();
      expect(s.source).not.toBe("rules");
      messages.push(s.message);
    }
    expect(client.calls).toBe(3);
    // Each message names a different customer
    expect(messages[0]).toContain("PersAva");
    expect(messages[1]).toContain("PersBen");
    expect(messages[2]).toContain("PersCara");
    expect(new Set(messages).size).toBe(3);

    // Revisit: cache hits, no more AI calls
    for (const id of ids) {
      const r = await app.inject({ method: "POST", url: `/api/outreach/${id}/suggestion`, payload: { channel: "sms" } });
      expect(r.json().cached).toBe(true);
      expect(r.json().suggestion.template).toBeFalsy();
    }
    expect(client.calls).toBe(3);
  });

  it("rules greeting never emits Hi ____ or Hi ,", async () => {
    const { RulesSuggestionProvider } = await import("../src/providers/ai.js");
    const rules = new RulesSuggestionProvider();
    const { app: a, store } = await makeApp({ suggestions: rules });
    app = a;
    const actor = { userId: DEMO_USER_ID, orgId: DEMO_ORG_ID };
    await store.importCustomers(actor, [{
      row: 1, externalId: null, firstName: "____", lastName: "Blank", phone: "+15555557777", email: "blank@example.com",
      location: null, age: 30, lastPurchaseAt: null, lifetimeSpendCents: 0, rewardsPoints: null, lifetimeOrders: null, customerSince: null
    }], IN_STORE_SIGNUP);
    const q = (await app.inject("/api/outreach/queue?limit=50")).json();
    const card = q.items.find((i: any) => i.customer.firstName === "____");
    const r = await app.inject({ method: "POST", url: `/api/outreach/${card.id}/suggestion`, payload: { channel: "sms" } });
    expect(r.json().suggestion.message).toMatch(/^Hi there,/);
    expect(r.json().suggestion.message).not.toMatch(/Hi ____|Hi ,/);
  });
});
