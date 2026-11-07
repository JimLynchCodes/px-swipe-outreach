import { afterEach, describe, expect, it } from "vitest";
import { createSuggestionProvider, openRouterCostLookup, type ChatCompletionClient } from "../src/providers/ai.js";
import { _resetCatalogCache, listModels, modelInfo, primaryProvider, refreshOpenRouterCatalog, routesFor } from "../src/ai/models.js";
import { loadConfig } from "../src/config.js";
import { evalCases } from "../src/ai/evals/fixtures.js";
import { makeApp } from "./helpers.js";
import { MemoryStore } from "../src/store/memory.js";
import { DEMO_ORG_ID, DEMO_USER_ID } from "../src/data/seed.js";

const c = evalCases().find(x => x.id === "jamal-sms")!;
const good = JSON.stringify({ promotion_id: "deal_0007", reason: "Cigar regular.", send_time: "Friday morning",
  sms_text: "Hi Jamal! Cigar Friday: 20% off cigars this Friday. 21+ w/ ID.", email_subject: "Cigar Friday, Jamal", email_body: "Hi Jamal, Cigar Friday is 20% off.", confidence: 0.9 });
const client = (o: { cost?: number; fail?: boolean; id?: string } = {}) => {
  const calls: Array<Record<string, unknown>> = [];
  const cl: ChatCompletionClient = { async create(p) {
    calls.push(p);
    if (o.fail) throw new Error("upstream 502");
    return { id: o.id ?? "gen-1", choices: [{ message: { content: good } }], usage: { prompt_tokens: 900, completion_tokens: 80, ...(o.cost !== undefined ? { cost: o.cost } : {}) } };
  } };
  return { cl, calls };
};

afterEach(() => _resetCatalogCache());

describe("provider resolution", () => {
  it("defaults to OpenRouter when its key is set; AI_PROVIDER overrides; validated at startup", () => {
    expect(primaryProvider({ OPENROUTER_API_KEY: "k", OPENAI_API_KEY: "k" })).toBe("openrouter");
    expect(primaryProvider({ OPENAI_API_KEY: "k" })).toBe("openai");
    expect(primaryProvider({ OPENROUTER_API_KEY: "k", OPENAI_API_KEY: "k", AI_PROVIDER: "openai" })).toBe("openai");
    expect(primaryProvider({})).toBeNull();
    expect(() => loadConfig({ NODE_ENV: "test", AI_PROVIDER: "openrouter" })).toThrow(/OPENROUTER_API_KEY/);
    expect(() => loadConfig({ NODE_ENV: "test", AI_PROVIDER: "openai" })).toThrow(/OPENAI_API_KEY/);
    expect(() => loadConfig({ NODE_ENV: "test", OPENAI_MODEL: "gpt-9" })).toThrow(/OPENAI_MODEL/);
  });
  it("routes a model to its provider, primary first, with the alias on the other provider as fallback", () => {
    const both = { OPENROUTER_API_KEY: "k", OPENAI_API_KEY: "k" };
    expect(routesFor("gpt-4o-mini", both)).toEqual([{ provider: "openrouter", model: "openai/gpt-4o-mini" }, { provider: "openai", model: "gpt-4o-mini" }]);
    expect(routesFor("openai/gpt-4o-mini", { ...both, AI_PROVIDER: "openai" })[0]).toEqual({ provider: "openai", model: "gpt-4o-mini" });
    expect(routesFor("anthropic/claude-haiku-5.5", { OPENAI_API_KEY: "k" })).toEqual([]);
    expect(routesFor("rules", both)).toEqual([]);
  });
});

describe("OpenRouter provider", () => {
  it("calls the OpenAI-compatible API with JSON schema, usage accounting and require_parameters; records exact cost", async () => {
    const { cl, calls } = client({ cost: 0.000184 });
    const p = createSuggestionProvider({ openrouterKey: "sk-or", openrouter: { client: cl } });
    const s = await p.suggest({ ...c.input, model: "anthropic/claude-haiku-5.5" });
    expect(s).toMatchObject({ source: "openrouter", model: "anthropic/claude-haiku-5.5", usage: { inputTokens: 900, outputTokens: 80, costUsd: 0.000184 } });
    expect(calls[0]).toMatchObject({ model: "anthropic/claude-haiku-5.5", usage: { include: true }, provider: { require_parameters: true },
      response_format: { type: "json_schema", json_schema: { strict: true } } });
  });
  it("looks up cost by generation id when usage.cost is missing; falls back to the price table if unavailable", async () => {
    const looked: string[] = [];
    const { cl } = client({ id: "gen-42" });
    const s = await createSuggestionProvider({ openrouterKey: "k", openrouter: { client: cl, lookupCost: async id => { looked.push(id); return 0.0005; } } }).suggest({ ...c.input, model: "openai/gpt-4o-mini" });
    expect(looked).toEqual(["gen-42"]);
    expect(s.usage!.costUsd).toBe(0.0005);
    const s2 = await createSuggestionProvider({ openrouterKey: "k", openrouter: { client: client().cl, lookupCost: async () => null } }).suggest({ ...c.input, model: "openai/gpt-4o-mini" });
    expect(s2.usage!.costUsd).toBeUndefined();
  });
  it("openRouterCostLookup reads data.total_cost from /api/v1/generation", async () => {
    let url = "";
    const f = (async (u: string) => { url = u; return new Response(JSON.stringify({ data: { total_cost: 0.0012 } })); }) as unknown as typeof fetch;
    expect(await openRouterCostLookup("k", f)("gen 1")).toBe(0.0012);
    expect(url).toBe("https://openrouter.ai/api/v1/generation?id=gen%201");
  });
  it("falls back to direct OpenAI on an OpenRouter error, then to rules", async () => {
    const direct = client({});
    const p = createSuggestionProvider({ openrouterKey: "k", apiKey: "sk", openrouter: { client: client({ fail: true }).cl, maxRetries: 0 }, openai: { client: direct.cl } });
    const s = await p.suggest({ ...c.input, model: "openai/gpt-4o-mini" });
    expect(s).toMatchObject({ source: "openai", model: "gpt-4o-mini" });
    expect(direct.calls[0]).not.toHaveProperty("usage");
    const r = await createSuggestionProvider({ openrouterKey: "k", openrouter: { client: client({ fail: true }).cl } }).suggest({ ...c.input, model: "google/gemini-2.5-flash-lite" });
    expect(r.source).toBe("rules");
  });
});

describe("catalog refresh", () => {
  it("updates allowlisted prices from /api/v1/models, hides models without structured outputs, and caches", async () => {
    let n = 0;
    const f = (async () => { n++; return new Response(JSON.stringify({ data: [
      { id: "openai/gpt-4o-mini", pricing: { prompt: "0.0000002", completion: "0.0000008" }, supported_parameters: ["structured_outputs", "response_format"] },
      { id: "google/gemini-2.5-flash-lite", pricing: { prompt: "0.0000001", completion: "0.0000004" }, supported_parameters: ["response_format"] },
      { id: "some/other-model", pricing: { prompt: "0", completion: "0" }, supported_parameters: ["structured_outputs"] }
    ] })); }) as unknown as typeof fetch;
    const r = await refreshOpenRouterCatalog({ fetchImpl: f, now: 1e12 });
    expect(r).toMatchObject({ refreshed: true, updated: 1 });
    expect(modelInfo("openai/gpt-4o-mini")).toMatchObject({ inputPerM: 0.2, outputPerM: 0.8 });
    const ids = listModels({ OPENROUTER_API_KEY: "k" }).map(m => m.id);
    expect(ids).not.toContain("google/gemini-2.5-flash-lite");
    expect(ids).not.toContain("some/other-model");
    expect((await refreshOpenRouterCatalog({ fetchImpl: f, now: 1e12 + 1000 })).refreshed).toBe(false);
    expect(n).toBe(1);
  });
});

describe("cost metrics", () => {
  it("records OpenRouter's reported cost (price_version provider-reported), including a rejected attempt's", async () => {
    const store = new MemoryStore();
    const { app } = await makeApp({ store, suggestions: createSuggestionProvider({ openrouterKey: "k", openrouter: { client: client({ cost: 0.000321 }).cl } }) });
    const r = await app.inject({ method: "POST", url: "/api/outreach/opp_0001/suggestion", payload: { channel: "sms" } });
    // The canned copy names Jamal, so for opp_0001 (Sarah) it is rejected twice → rules; the spend is still recorded exactly.
    expect(r.json().suggestion.source).toBe("rules");
    const rows = (await store.listAiUsage({ orgId: DEMO_ORG_ID, userId: DEMO_USER_ID }, "2000-01-01")).filter(x => !x.isDemo);
    expect(rows[0]).toMatchObject({ provider: "openrouter", model: "openai/gpt-4o-mini", inputTokens: 1800, priceVersion: "provider-reported" });
    expect(rows[0].costUsd).toBeCloseTo(0.000642, 9);
    expect(rows[1]).toMatchObject({ provider: "rules", costUsd: 0 });
  });
});
