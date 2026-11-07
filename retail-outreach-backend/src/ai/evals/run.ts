/**
 * Outreach-copy evals. `npm run eval` replays recorded model outputs (deterministic, no network, runs in CI) through
 * the real provider: JSON schema, compliance validator, regeneration, and fallback.
 *   npm run eval                       recorded mode (default)
 *   npm run eval -- --live             call the configured provider (AI_PROVIDER; OpenRouter if OPENROUTER_API_KEY, else OpenAI); prints tokens and cost
 *   npm run eval -- --live --judge     also grade tone/relevance/persuasiveness 1-5 with an LLM-as-judge
 *   npm run eval -- --live --record    overwrite recorded.json with the live outputs
 *   --model google/gemini-2.5-flash-lite  --judge-model openai/gpt-4o-mini  --limit 5   (AI_MODEL env also sets the model)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assembleSms, checkCopy, isGsm7, SMS_LIMIT, EMAIL_SUBJECT_LIMIT } from "../compliance.js";
import { costUsd, DEFAULT_AI_MODEL, modelInfo, primaryProvider, routesFor, type AiKeys } from "../models.js";
import { AiAttemptError, eligiblePromotions, OPENROUTER_BASE_URL, OpenAISuggestionProvider, RulesSuggestionProvider, type ChatCompletionClient } from "../../providers/ai.js";
import { EVAL_CAP, EVAL_SIGNATURE, evalCases, type EvalCase } from "./fixtures.js";

export const RECORDED_PATH = fileURLToPath(new URL("./recorded.json", import.meta.url));
export type Recording = { attempts: Array<{ content: string; inputTokens: number; outputTokens: number }> };
export type Recordings = { note: string; promptVersion: string; cases: Record<string, Recording> };

/** Replays recorded attempts in order (attempt 2 is only used if attempt 1 was rejected). */
export function replayClient(rec: Recording | undefined): ChatCompletionClient {
  let i = 0;
  return {
    async create() {
      const a = rec?.attempts[i++];
      if (!a) throw new Error("no recorded output for this attempt");
      return { choices: [{ message: { content: a.content } }], usage: { prompt_tokens: a.inputTokens, completion_tokens: a.outputTokens } };
    }
  };
}

export type CaseResult = {
  id: string; channel: string; source: "openai" | "openrouter" | "rules"; attempts: number; promotion: string | null;
  relevant: boolean; compliant: boolean; smsChars: number | null; gsm7: boolean | null; subjectChars: number | null;
  inputTokens: number; outputTokens: number; costUsd: number; fallbackReason?: string; judge?: { tone: number; relevance: number; persuasiveness: number };
};

/** Run one case through the real provider + rules fallback, then re-check the final copy deterministically. */
export async function runCase(c: EvalCase, client: ChatCompletionClient, model: string): Promise<CaseResult & { message: string; subject: string | null }> {
  let attempts = 0;
  const counting: ChatCompletionClient = { create: (p, o) => { attempts++; return client.create(p, o); } };
  const providerId = modelInfo(model)?.provider === "openai" ? "openai" : "openrouter";
  const provider = new OpenAISuggestionProvider("eval", model, { client: counting, maxRetries: 0, providerId });
  const input = { ...c.input, model };
  let s, usage: { inputTokens: number; outputTokens: number; costUsd?: number } = { inputTokens: 0, outputTokens: 0 }, fallbackReason: string | undefined;
  try { s = await provider.suggest(input); usage = s.usage ?? usage; }
  catch (e) {
    if (e instanceof AiAttemptError) { usage = e.usage; fallbackReason = e.message; } else fallbackReason = String(e);
    s = await new RulesSuggestionProvider().suggest(input);
  }
  const customer = c.input.opportunity.customer;
  const eligible = eligiblePromotions(c.input.promotions ?? [], EVAL_CAP, c.input.now?.getTime());
  const promo = s.deal ? eligible.find(d => d.id === s.deal!.id) ?? null : null;
  const favs = new Set(customer.profile.favoriteCategories);
  const relevant = promo ? promo.categories.some(x => favs.has(x)) : !eligible.some(d => d.categories.some(x => favs.has(x)));
  // Final copy check: strip the appended signature/opt-out/footer and run the same validator on what the model wrote.
  const text = c.channel === "sms" ? s.message.split("\n")[0].replace(` ${EVAL_SIGNATURE}`, "") : s.message;
  const check = s.source !== "rules"
    ? checkCopy(c.channel === "sms" ? { smsText: text } : { emailSubject: s.subject ?? "", emailBody: text.split("\n\nYou're receiving")[0] },
        { channel: c.channel, firstName: customer.firstName, lastName: customer.lastName, promotion: promo, rewardsPoints: customer.rewards?.member ? customer.rewards.points : null, offerPercent: promo ? null : c.input.opportunity.offer?.discountPercent ?? null,
          maxDiscountPercent: EVAL_CAP, smsSignature: EVAL_SIGNATURE, now: c.input.now })
    : { violations: [] };
  const sms = c.channel === "sms" ? (s.source !== "rules" ? assembleSms(text, EVAL_SIGNATURE) : s.message) : null;
  return {
    id: c.id, channel: c.channel, source: s.source, attempts, promotion: s.deal?.title ?? null, relevant,
    compliant: check.violations.length === 0, smsChars: sms?.length ?? null, gsm7: sms ? isGsm7(sms) : null,
    subjectChars: s.subject?.length ?? null, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd ?? costUsd(model, usage.inputTokens, usage.outputTokens),
    fallbackReason, message: s.message, subject: s.subject
  };
}

export async function runEvals(opts: { client: (c: EvalCase) => ChatCompletionClient; model: string; limit?: number }) {
  const cases = evalCases().slice(0, opts.limit);
  const results = [];
  for (const c of cases) results.push(await runCase(c, opts.client(c), opts.model));
  return results;
}

export function scorecard(results: CaseResult[]) {
  const n = results.length, ai = results.filter(r => r.source !== "rules");
  const pct = (k: number, d = n) => d ? `${Math.round((k / d) * 100)}%` : "n/a";
  const sms = results.filter(r => r.smsChars !== null && r.source !== "rules");
  const judged = results.filter(r => r.judge);
  const avg = (k: "tone" | "relevance" | "persuasiveness") => (judged.reduce((a, r) => a + r.judge![k], 0) / judged.length).toFixed(2);
  return {
    cases: n,
    "AI copy accepted": `${ai.length}/${n} (${pct(ai.length)})`,
    "accepted first try": `${ai.filter(r => r.attempts === 1).length}/${n}`,
    "regenerated then accepted": `${ai.filter(r => r.attempts > 1).length}/${n}`,
    "fell back to rules": `${n - ai.length}/${n}`,
    "compliant (final copy)": `${results.filter(r => r.compliant).length}/${n}`,
    "relevant promotion": `${results.filter(r => r.relevant).length}/${n} (${pct(results.filter(r => r.relevant).length)})`,
    [`SMS ≤${SMS_LIMIT} incl. signature + opt-out`]: `${sms.filter(r => r.smsChars! <= SMS_LIMIT).length}/${sms.length}`,
    "SMS GSM-7": `${sms.filter(r => r.gsm7).length}/${sms.length}`,
    [`email subject ≤${EMAIL_SUBJECT_LIMIT}`]: `${results.filter(r => r.subjectChars !== null && r.subjectChars <= EMAIL_SUBJECT_LIMIT).length}/${results.filter(r => r.subjectChars !== null).length}`,
    tokens: `${results.reduce((a, r) => a + r.inputTokens, 0)} in / ${results.reduce((a, r) => a + r.outputTokens, 0)} out`,
    "cost (USD)": `$${results.reduce((a, r) => a + r.costUsd, 0).toFixed(5)}`,
    ...(judged.length ? { "judge tone (1-5)": avg("tone"), "judge relevance (1-5)": avg("relevance"), "judge persuasiveness (1-5)": avg("persuasiveness") } : {})
  };
}

async function judge(client: ChatCompletionClient, model: string, c: EvalCase, r: { message: string; subject: string | null }) {
  const res = await client.create({
    model, temperature: 0, max_completion_tokens: 200,
    response_format: { type: "json_schema", json_schema: { name: "judge", strict: true, schema: { type: "object", additionalProperties: false,
      properties: { tone: { type: "integer" }, relevance: { type: "integer" }, persuasiveness: { type: "integer" } }, required: ["tone", "relevance", "persuasiveness"] } } },
    messages: [
      { role: "system", content: "Grade a smoke-shop marketing message 1-5 on: tone (matches a friendly local shop, natural, not pushy), relevance (offer fits this customer's favorites/habits), persuasiveness (likely to bring them in without pressure). Return JSON." },
      { role: "user", content: JSON.stringify({ customer: { favorites: c.input.opportunity.customer.profile.favoriteCategories, segment: c.input.recommendation.segment }, subject: r.subject, message: r.message }) }
    ]
  });
  return { judgment: JSON.parse(res.choices[0]?.message?.content ?? "{}"), usage: res.usage };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (f: string) => args.includes(f);
  const val = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  const keys = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, AI_PROVIDER: process.env.AI_PROVIDER as AiKeys["AI_PROVIDER"] };
  const primary = primaryProvider(keys) ?? "openrouter";
  const model = val("--model") ?? process.env.AI_MODEL ?? (primary === "openai" ? "gpt-4o-mini" : DEFAULT_AI_MODEL);
  const limit = val("--limit") ? Number(val("--limit")) : undefined;
  const live = flag("--live");
  let liveClient: ChatCompletionClient | undefined;
  const recorded: Recordings = JSON.parse(readFileSync(RECORDED_PATH, "utf8"));
  const captured: Record<string, Recording> = {};
  if (live) {
    const route = routesFor(model, keys)[0];
    if (!route) { console.error(`--live needs OPENROUTER_API_KEY or OPENAI_API_KEY for ${model}`); process.exit(2); }
    if (route.model !== model) { console.error(`${model} runs on ${route.provider} as ${route.model}; pass --model ${route.model}`); process.exit(2); }
    const { default: OpenAI } = await import("openai");
    const sdk = route.provider === "openrouter"
      ? new OpenAI({ apiKey: keys.OPENROUTER_API_KEY, baseURL: OPENROUTER_BASE_URL, defaultHeaders: { "X-Title": "PX Swipe Outreach evals" }, maxRetries: 2, timeout: 30_000 })
      : new OpenAI({ maxRetries: 2, timeout: 30_000 });
    console.log(`live provider: ${route.provider}`);
    liveClient = { create: (p, o) => sdk.chat.completions.create(p as never, o) as never };
  }
  const clientFor = (c: EvalCase): ChatCompletionClient => {
    if (!liveClient) return replayClient(recorded.cases[c.id]);
    const rec: Recording = (captured[c.id] = { attempts: [] });
    return { create: async (p, o) => {
      const res = await liveClient!.create(p, o);
      rec.attempts.push({ content: res.choices[0]?.message?.content ?? "", inputTokens: res.usage?.prompt_tokens ?? 0, outputTokens: res.usage?.completion_tokens ?? 0 });
      return res;
    } };
  };
  const results: CaseResult[] = [];
  let judgeCost = 0;
  for (const c of evalCases().slice(0, limit)) {
    const r = await runCase(c, clientFor(c), model);
    if (live && flag("--judge") && r.source !== "rules") {
      const jm = val("--judge-model") ?? (primary === "openai" ? "gpt-4o-mini" : DEFAULT_AI_MODEL);
      const j = await judge(liveClient!, jm, c, r);
      r.judge = j.judgment;
      judgeCost += costUsd(jm, j.usage?.prompt_tokens ?? 0, j.usage?.completion_tokens ?? 0);
    }
    results.push(r);
  }
  console.log(`Outreach copy evals (${live ? `LIVE ${model}` : `recorded outputs, ${model} prices`}; prompt ${(await import("../prompt.js")).PROMPT_VERSION})\n`);
  console.table(results.map(r => ({ case: r.id, source: r.source, tries: r.attempts, promotion: r.promotion ?? "-", relevant: r.relevant ? "yes" : "NO", compliant: r.compliant ? "yes" : "NO",
    chars: r.smsChars ?? r.subjectChars, cost: `$${r.costUsd.toFixed(5)}`, ...(r.judge ? { judge: `${r.judge.tone}/${r.judge.relevance}/${r.judge.persuasiveness}` } : {}) })));
  for (const r of results.filter(r => r.fallbackReason)) console.log(`fallback ${r.id}: ${r.fallbackReason}`);
  console.log("\nScorecard");
  for (const [k, v] of Object.entries(scorecard(results))) console.log(`  ${k.padEnd(40)} ${v}`);
  if (judgeCost) console.log(`  ${"judge cost (USD)".padEnd(40)} $${judgeCost.toFixed(5)}`);
  if (live && flag("--record")) {
    const { PROMPT_VERSION } = await import("../prompt.js");
    writeFileSync(RECORDED_PATH, JSON.stringify({ note: `Recorded live from ${model} on ${new Date().toISOString().slice(0, 10)}.`, promptVersion: PROMPT_VERSION, cases: captured }, null, 2) + "\n");
    console.log(`\nwrote ${RECORDED_PATH}`);
  }
  const hardFail = results.some(r => !r.compliant || (r.smsChars !== null && r.source !== "rules" && r.smsChars > SMS_LIMIT));
  process.exit(hardFail ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main();
