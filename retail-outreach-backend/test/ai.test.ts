import { describe, expect, it } from "vitest";
import { FallbackSuggestionProvider, RulesSuggestionProvider, createSuggestionProvider } from "../src/providers/ai.js";
import { buildSeedOpportunities } from "../src/store/memory.js";
import { humanizeDays, isValidPhone } from "../src/domain.js";

const opps = buildSeedOpportunities();

describe("suggestion providers", () => {
  it("uses rules when no API key is configured", () => {
    expect(createSuggestionProvider({ model: "x" }).name).toBe("rules");
  });

  it("covers every seeded campaign type", async () => {
    const rules = new RulesSuggestionProvider();
    for (const opportunity of opps) {
      const s = await rules.suggest({ opportunity, channel: "sms", businessName: "Shop" });
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.message).toContain(opportunity.customer.firstName);
    }
  });

  it("falls back to rules when the primary provider fails", async () => {
    const errors: unknown[] = [];
    const p = new FallbackSuggestionProvider(
      { name: "openai", suggest: async () => { throw new Error("rate limited"); } },
      new RulesSuggestionProvider(), e => errors.push(e));
    const s = await p.suggest({ opportunity: opps[0], channel: "sms", businessName: "Shop" });
    expect(s.source).toBe("rules");
    expect(errors).toHaveLength(1);
  });
});

describe("domain helpers", () => {
  it("humanizes day counts", () => {
    expect(humanizeDays(68)).toBe("over two months");
    expect(humanizeDays(364)).toBe("over twelve months");
    expect(humanizeDays(20)).toBe("over two weeks");
  });
  it("validates phone numbers", () => {
    expect(isValidPhone("+1 (555) 555-0123")).toBe(true);
    expect(isValidPhone("123")).toBe(false);
    expect(isValidPhone(null)).toBe(false);
  });
});
