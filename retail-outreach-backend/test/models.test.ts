import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { fakeSupabase, makeApp } from "./helpers.js";
import { MemoryStore } from "../src/store/memory.js";
import { DEMO_ORG, DEMO_ORG_ID } from "../src/data/seed.js";
import { costUsd, DEFAULT_AI_MODEL, listModels, MODELS, PRICE_TABLE_VERSION } from "../src/ai/models.js";
import { createSuggestionProvider, finalizeSuggestion, ModelRouter, RulesSuggestionProvider, type SuggestionInput, type SuggestionProvider } from "../src/providers/ai.js";

let app: FastifyInstance;
afterEach(async () => { await app?.close(); });

/** Pretends to be an LLM provider; records which model it was asked for. */
class FakeProvider implements SuggestionProvider {
  readonly name = "openai" as const;
  calls: string[] = [];
  constructor(private fail = false) {}
  async suggest(input: SuggestionInput) {
    this.calls.push(input.model!);
    if (this.fail) throw new Error("boom");
    return finalizeSuggestion({ title: `AI ${input.model}`, reasoning: "r", message: "Hi", subject: null }, input, "openai",
      { model: input.model, usage: { inputTokens: 700, outputTokens: 150 } });
  }
}

describe("model catalog", () => {
  it("defaults to GPT-4o mini via OpenRouter and includes rules-only", () => {
    expect(DEFAULT_AI_MODEL).toBe("openai/gpt-4o-mini");
    const openai = MODELS.filter(m => m.provider === "openai");
    expect(Math.min(...openai.map(m => m.inputPerM + m.outputPerM))).toBe(0.15 + 0.6);
    expect(MODELS.find(m => m.id === "rules")).toMatchObject({ inputPerM: 0, outputPerM: 0 });
    expect(PRICE_TABLE_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("prices calls with sub-cent precision", () => {
    expect(costUsd("gpt-4o-mini", 700, 150)).toBeCloseTo(0.000195, 9);
    expect(costUsd("rules", 1e6, 1e6)).toBe(0);
  });
  it("marks models unavailable without a key; OpenRouter also serves OpenAI models via aliases", () => {
    const none = listModels({});
    expect(none.find(m => m.id === "gpt-4o-mini")).toMatchObject({ available: false, note: expect.stringContaining("OPENAI_API_KEY") });
    expect(none.find(m => m.id === "openai/gpt-4o-mini")).toMatchObject({ available: false, note: expect.stringContaining("OPENROUTER_API_KEY") });
    const or = listModels({ OPENROUTER_API_KEY: "sk-or-x" });
    expect(or.filter(m => m.provider === "openrouter").every(m => m.available)).toBe(true);
    expect(or.find(m => m.id === "gpt-4o-mini")!.available).toBe(true); // alias → openai/gpt-4o-mini
    expect(or.find(m => m.id === "gpt-5.4-nano")!.available).toBe(false); // no OpenRouter alias
    expect(listModels({ OPENAI_API_KEY: "sk-x" }).find(m => m.id === "google/gemini-2.5-flash-lite")!.available).toBe(false);
    expect(none.find(m => m.id === "rules")).toMatchObject({ available: true, costHint: "Heuristic-based canned suggestions, free", label: "None", inputPerM: 0 });
    expect(listModels({ OPENAI_API_KEY: "sk-x" }).filter(m => m.provider === "openai").every(m => m.available)).toBe(true);
  });
});

describe("ModelRouter", () => {
  const base = (model?: string) => ({ model }) as unknown as SuggestionInput;
  it("routes by the org's model, uses rules for 'rules'/unknown/unconfigured, and falls back on errors", async () => {
    const calls: string[] = [];
    const fake = { name: "openai" as const, calls, suggest: async (i: SuggestionInput) => { calls.push(i.model!); return { model: i.model } } } as unknown as SuggestionProvider & { calls: string[] };
    const failing = { name: "openai" as const, suggest: async () => { throw new Error("boom"); } } as unknown as SuggestionProvider;
    const rules = { name: "rules" as const, suggest: async () => ({ source: "rules", model: "rules" }) } as unknown as SuggestionProvider;
    const r = new ModelRouter({ openai: fake }, rules);
    expect((await r.suggest(base("gpt-5-mini"))).model).toBe("gpt-5-mini");
    expect((await r.suggest(base("rules"))).model).toBe("rules");
    expect((await r.suggest(base("made-up"))).model).toBe("rules");
    expect((await r.suggest(base(undefined))).model).toBe("gpt-4o-mini");
    expect(fake.calls).toEqual(["gpt-5-mini", "gpt-4o-mini"]);
    expect((await new ModelRouter({}, rules).suggest(base("gpt-4o-mini"))).model).toBe("rules");
    expect((await new ModelRouter({ openai: failing }, rules).suggest(base("gpt-4o-mini"))).model).toBe("rules");
  });
  it("without OPENAI_API_KEY everything is rules", () => {
    expect(createSuggestionProvider({}).name).toBe("rules");
  });
});

describe("model picker API", () => {
  it("lists models with availability; the suggestion uses the org's model; changing it is owner/admin only and allowlisted", async () => {
    const store = new MemoryStore();
    const STAFF = "33333333-3333-4333-8333-333333333333";
    store.addMembership(STAFF, { orgId: DEMO_ORG_ID, orgName: DEMO_ORG.name, businessName: DEMO_ORG.businessName, role: "staff" });
    const fake = await fakeSupabase();
    const provider = new FakeProvider();
    ({ app } = await makeApp({ store, authenticator: fake.authenticator, suggestions: new ModelRouter({ openai: provider }, new RulesSuggestionProvider()) }));
    const OWNER = "11111111-1111-4111-8111-111111111111";
    store.addMembership(OWNER, { orgId: DEMO_ORG_ID, orgName: DEMO_ORG.name, businessName: DEMO_ORG.businessName, role: "owner" });
    const as = async (u: string) => ({ authorization: `Bearer ${await fake.sign(u)}`, "x-org-id": DEMO_ORG_ID });

    const list = (await app.inject({ url: "/api/ai/models", headers: await as(STAFF) })).json();
    expect(list.selected).toBe("openai/gpt-4o-mini");
    expect(list.effective).toBe("rules"); // test app has no OPENAI_API_KEY
    expect(list.models.map((m: any) => m.id)).toEqual(expect.arrayContaining(["openai/gpt-4o-mini", "anthropic/claude-haiku-5.5", "gpt-4o-mini", "gpt-5-mini", "rules"]));

    const sugg = async () => (await app.inject({ method: "POST", url: "/api/outreach/opp_0001/suggestion", payload: { channel: "sms" }, headers: await as(OWNER) })).json().suggestion;
    expect((await sugg()).model).toBe("gpt-4o-mini");
    const settings = (await app.inject({ url: "/api/settings", headers: await as(OWNER) })).json().settings;
    expect((await app.inject({ method: "PUT", url: "/api/settings", payload: { ...settings, aiModel: "gpt-5-mini" }, headers: await as(STAFF) })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: "/api/settings", payload: { ...settings, aiModel: "gpt-9-ultra" }, headers: await as(OWNER) })).statusCode).toBe(400);
    const ok = await app.inject({ method: "PUT", url: "/api/settings", payload: { ...settings, aiModel: "gpt-5-mini" }, headers: await as(OWNER) });
    expect(ok.json().settings.aiModel).toBe("gpt-5-mini");
    expect((await sugg()).model).toBe("gpt-5-mini");
    await app.inject({ method: "PUT", url: "/api/settings", payload: { ...settings, aiModel: "rules" }, headers: await as(OWNER) });
    const rules = await sugg();
    expect(rules).toMatchObject({ model: "rules", source: "rules" });
    // Omitting aiModel keeps the current choice.
    const { aiModel: _a, ...noModel } = settings;
    expect((await app.inject({ method: "PUT", url: "/api/settings", payload: noModel, headers: await as(OWNER) })).json().settings.aiModel).toBe("rules");
  });
});
