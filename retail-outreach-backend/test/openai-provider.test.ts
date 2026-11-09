import { describe, expect, it } from "vitest";
import { AiAttemptError, createSuggestionProvider, eligiblePromotions, ModelRouter, OpenAISuggestionProvider, RulesSuggestionProvider, type ChatCompletionClient } from "../src/providers/ai.js";
import { systemPrompt, userPayload, smsBudget } from "../src/ai/prompt.js";
import { evalCases, evalPromotions, EVAL_CAP } from "../src/ai/evals/fixtures.js";
import { readFileSync } from "node:fs";
import { RECORDED_PATH, replayClient, runEvals, scorecard, type Recordings } from "../src/ai/evals/run.js";

const c = evalCases().find(x => x.id === "jamal-sms")!;
const reply = (o: Record<string, unknown>) => JSON.stringify({ promotion_id: "deal_0007", reason: "Cigar regular.", send_time: "Friday morning",
  sms_text: "Hi Jamal! Cigar Friday: 20% off cigars this Friday. 21+ w/ ID.", email_subject: "Cigar Friday, Jamal", email_body: "Hi Jamal, Cigar Friday is 20% off.", confidence: 0.9, ...o });
const scripted = (...contents: Array<string | Error>) => {
  const calls: Array<Record<string, unknown>> = [];
  const client: ChatCompletionClient = { async create(p) { calls.push(p); const x = contents.shift(); if (!x || x instanceof Error) throw x ?? new Error("none"); return { choices: [{ message: { content: x } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } }; } };
  return { client, calls };
};

describe("OpenAI provider", () => {
  it("only offers enabled, running, within-cap promotions", () => {
    const ids = eligiblePromotions(evalPromotions(), EVAL_CAP).map(d => d.id);
    expect(ids).toContain("promo_winter");
    expect(ids).not.toContain("promo_overcap"); // 40% > 25% cap
    expect(ids).not.toContain("deal_0001"); // inactive
  });

  it("builds a guarded prompt with voice, few-shots and the SMS budget", () => {
    const ctx = { storeName: "Cloud 9", voice: { preset: "premium" as const, emoji: false, signOff: "Cheers", about: "Since 2014" }, channel: "sms" as const, smsSignature: "-Cloud 9",
      maxDiscountPercent: 25, customer: c.input.opportunity.customer, segment: c.input.recommendation.segment, promotions: evalPromotions().slice(1, 3), recommendation: c.input.recommendation, offer: null, now: new Date() };
    const sys = systemPrompt(ctx);
    for (const s of ["health/safety", "youth appeal", "free tobacco", "intoxication", "fake urgency", "25% off", "first name", "No emoji", "Premium lounge", "Since 2014", `Example (${ctx.segment})`, `sms_text ≤${smsBudget("-Cloud 9")}`]) expect(sys).toContain(s);
    const user = userPayload(ctx);
    expect(user.customer).not.toHaveProperty("last_name");
    expect(JSON.stringify(user)).not.toMatch(/Carter|@|\+1/);
    expect(user.promotions.map(p => p.id)).toEqual(["deal_0002", "deal_0003"]);
  });

  it("returns compliant copy with low temperature, a token cap and the JSON schema", async () => {
    const { client, calls } = scripted(reply({}));
    const s = await new OpenAISuggestionProvider("k", "gpt-4o-mini", { client }).suggest(c.input);
    expect(s).toMatchObject({ source: "openai", model: "gpt-4o-mini", confidence: 0.9, deal: { id: "deal_0007" }, usage: { inputTokens: 1000, outputTokens: 100 } });
    expect(s.message).toBe("Hi Jamal! Cigar Friday: 20% off cigars this Friday. 21+ w/ ID. -Cloud 9\nReply STOP to opt out.");
    expect(calls[0]).toMatchObject({ temperature: 0.3, max_completion_tokens: 350, response_format: { type: "json_schema", json_schema: { name: "smoke_shop_outreach", strict: true } } });
  });

  it("regenerates once with violation feedback, summing usage", async () => {
    const { client, calls } = scripted(reply({ sms_text: "Hi Jamal! Cigar Friday: 30% off. 21+" }), reply({}));
    const s = await new OpenAISuggestionProvider("k", "gpt-4o-mini", { client }).suggest(c.input);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1].messages)).toContain("above the store's 25% discount cap");
    expect(s.usage).toEqual({ inputTokens: 2000, outputTokens: 200 });
  });

  it("throws AiAttemptError with spent tokens when both drafts fail, invalid JSON, or unknown promotion", async () => {
    for (const drafts of [[reply({ sms_text: "Hi Jamal, get high with Cigar Friday 20% off" }), reply({ sms_text: "Hurry Jamal! Cigar Friday 20% off" })],
      ["not json", reply({ promotion_id: "made_up" })]]) {
      const { client } = scripted(...drafts);
      const e = await new OpenAISuggestionProvider("k", "gpt-4o-mini", { client }).suggest(c.input).catch(x => x);
      expect(e).toBeInstanceOf(AiAttemptError);
      expect(e.usage).toEqual({ inputTokens: 2000, outputTokens: 200 });
    }
  });

  it("falls back to rules on errors/timeouts and carries the wasted attempt for cost metrics", async () => {
    const { client } = scripted(reply({ sms_text: "Hi Jamal, stoned yet? Cigar Friday 20% off" }), reply({ sms_text: "Hi Jamal, stoned yet? Cigar Friday 20% off" }));
    const router = new ModelRouter({ openai: new OpenAISuggestionProvider("k", "gpt-4o-mini", { client }) }, new RulesSuggestionProvider());
    const s = await router.suggest(c.input);
    expect(s).toMatchObject({ source: "rules", model: "rules", aiAttempt: { model: "gpt-4o-mini", usage: { inputTokens: 2000, outputTokens: 200 } } });
    const timeout = scripted(new Error("Request timed out."));
    const s2 = await new ModelRouter({ openai: new OpenAISuggestionProvider("k", "gpt-4o-mini", { client: timeout.client }) }).suggest(c.input);
    expect(s2.source).toBe("rules");
    expect(s2.aiAttempt).toBeUndefined();
  });

  it("passes SDK retry/timeout options through createSuggestionProvider", async () => {
    const seen: unknown[] = [];
    const client: ChatCompletionClient = { async create(_p, o) { seen.push(o); return { choices: [{ message: { content: reply({}) } }] }; } };
    await createSuggestionProvider({ apiKey: "k", openai: { client, timeoutMs: 1234, maxRetries: 3 } }).suggest({ ...c.input, model: "gpt-4o-mini" });
    expect(seen[0]).toEqual({ timeout: 1234, maxRetries: 3 });
  });
});

describe("evals (recorded mode, deterministic)", () => {
  it("every case is compliant and relevant, with the expected regeneration/fallback mix", async () => {
    const recorded: Recordings = JSON.parse(readFileSync(RECORDED_PATH, "utf8"));
    const results = await runEvals({ client: x => replayClient(recorded.cases[x.id]), model: "gpt-4o-mini" });
    expect(results.length).toBeGreaterThanOrEqual(20);
    expect(results.every(r => r.compliant && r.relevant)).toBe(true);
    expect(results.filter(r => r.source === "openai" && r.channel === "sms").every(r => r.smsChars! <= 160)).toBe(true);
    const card = scorecard(results);
    expect(card["regenerated then accepted"]).toBe(`4/${results.length}`);
    expect(card["fell back to rules"]).toBe(`1/${results.length}`);
  });
});
