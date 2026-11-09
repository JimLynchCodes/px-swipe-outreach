import { describe, expect, it } from "vitest";
import { makeApp } from "./helpers.js";
import type { SuggestionInput, SuggestionProvider } from "../src/providers/ai.js";
import { RulesSuggestionProvider } from "../src/providers/ai.js";
import { suggestionCacheKey } from "../src/ai/cache.js";
import { DEFAULT_SETTINGS } from "../src/store/types.js";

/** Counts real AI (non-rules) calls. */
function countingProvider(): SuggestionProvider & { calls: number } {
  const rules = new RulesSuggestionProvider();
  const p: SuggestionProvider & { calls: number } = {
    name: "openai", calls: 0,
    async suggest(input: SuggestionInput) {
      p.calls++;
      const s = await rules.suggest(input);
      return { ...s, source: "openai", model: "gpt-4o-mini", usage: { inputTokens: 100, outputTokens: 40 } };
    }
  };
  return p;
}

describe("suggestion cache (no AI on revisit)", () => {
  it("serves a cached suggestion on the second request without calling the provider again", async () => {
    const ai = countingProvider();
    const { app } = await makeApp({ suggestions: ai });
    const first = await app.inject({ method: "POST", url: "/api/outreach/opp_0001/suggestion", payload: { channel: "sms" } });
    expect(first.statusCode).toBe(200);
    expect(first.json().cached).toBe(false);
    expect(ai.calls).toBe(1);

    const second = await app.inject({ method: "POST", url: "/api/outreach/opp_0001/suggestion", payload: { channel: "sms" } });
    expect(second.statusCode).toBe(200);
    expect(second.json().cached).toBe(true);
    expect(second.json().suggestion.message).toBe(first.json().suggestion.message);
    expect(ai.calls).toBe(1); // no new AI call — navigating back hits the cache
  });

  it("navigating away and back (deck prepare twice) makes no new AI call", async () => {
    const ai = countingProvider();
    const { app } = await makeApp({ suggestions: ai });
    const prep1 = await app.inject({ method: "POST", url: "/api/outreach/deck/prepare", payload: { limit: 3 } });
    expect(prep1.statusCode).toBe(200);
    const a = prep1.json();
    expect(a.generated).toBeGreaterThan(0);
    expect(ai.calls).toBe(a.generated);

    const prep2 = await app.inject({ method: "POST", url: "/api/outreach/deck/prepare", payload: { limit: 3 } });
    expect(prep2.json()).toMatchObject({ generated: 0, cached: a.generated + a.cached, failed: 0 });
    expect(ai.calls).toBe(a.generated); // still the same
  });

  it("refresh:true forces a new AI call and records usage again", async () => {
    const ai = countingProvider();
    const { app } = await makeApp({ suggestions: ai });
    await app.inject({ method: "POST", url: "/api/outreach/opp_0001/suggestion", payload: { channel: "sms" } });
    expect(ai.calls).toBe(1);
    const r = await app.inject({ method: "POST", url: "/api/outreach/opp_0001/suggestion", payload: { channel: "sms", refresh: true } });
    expect(r.json().cached).toBe(false);
    expect(ai.calls).toBe(2);
  });

  it("fingerprint changes when the model changes (cache miss)", () => {
    const a = suggestionCacheKey({
      aiModel: "openai/gpt-4o-mini", brandVoice: DEFAULT_SETTINGS.brandVoice, maxDiscountPercent: 25,
      smsSignature: "", emailSignature: "", storeName: "Cloud 9", promotions: [], channel: "sms"
    });
    const b = suggestionCacheKey({
      aiModel: "rules", brandVoice: DEFAULT_SETTINGS.brandVoice, maxDiscountPercent: 25,
      smsSignature: "", emailSignature: "", storeName: "Cloud 9", promotions: [], channel: "sms"
    });
    expect(a).not.toBe(b);
  });
});
