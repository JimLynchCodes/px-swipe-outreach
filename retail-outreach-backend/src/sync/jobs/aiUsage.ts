/**
 * AI usage: provider-reported usage + cost per day and model, reconciled with what the app recorded (ai_usage).
 *  - OpenAI: Usage API (completions, grouped by model) + Costs API (grouped by line item). Needs OPENAI_ADMIN_KEY.
 *  - OpenRouter: /api/v1/activity (last 30 UTC days per model; needs a provisioning key, OPENROUTER_PROVISIONING_KEY,
 *    falling back to OPENROUTER_API_KEY) and /api/v1/credits (balance, logged).
 * Idempotent: rows upsert on (org, provider, day, model). Watermark = last complete UTC day; each run re-reads 2 days
 * before it because providers finalize late.
 */
import { getJson } from "../http.js";
import { addDays, isoDay, type JobContext, type JobDef } from "../job.js";
import type { ProviderUsageRow, ReconciledUsageRow } from "../types.js";

const OPENAI = "https://api.openai.com/v1/organization";
const OPENROUTER = "https://openrouter.ai/api/v1";

/** "gpt-4o-mini-2024-07-18" → "gpt-4o-mini"; Costs line items look like "gpt-4o-mini-2024-07-18, input". */
export const normalizeOpenAiModel = (m: string) => m.split(",")[0].trim().replace(/-\d{4}-\d{2}-\d{2}$/, "");

async function pages<T>(ctx: JobContext, first: string, headers: Record<string, string>): Promise<T[]> {
  const out: T[] = [];
  let url: string | null = first;
  for (let i = 0; url && i < 50; i++) {
    const body: any = await getJson(url, { headers, fetchImpl: ctx.fetchImpl, retry: ctx.retry });
    out.push(...(body.data ?? []));
    url = body.has_more && body.next_page ? `${first.split("&page=")[0]}&page=${encodeURIComponent(body.next_page)}` : null;
  }
  return out;
}

export async function fetchOpenAiUsage(ctx: JobContext, key: string, sinceDay: string): Promise<ProviderUsageRow[]> {
  const start = Date.parse(`${sinceDay}T00:00:00Z`) / 1000;
  const h = { authorization: `Bearer ${key}` };
  const usage = await pages<any>(ctx, `${OPENAI}/usage/completions?start_time=${start}&bucket_width=1d&group_by=model&limit=31`, h);
  const costs = await pages<any>(ctx, `${OPENAI}/costs?start_time=${start}&bucket_width=1d&group_by=line_item&limit=31`, h);
  const rows = new Map<string, ProviderUsageRow>();
  const row = (day: string, model: string) => {
    const k = `${day}|${model}`;
    let r = rows.get(k);
    if (!r) rows.set(k, r = { provider: "openai", day, model, requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
    return r;
  };
  for (const b of usage) {
    const day = isoDay(new Date(b.start_time * 1000));
    for (const x of b.results ?? []) {
      const r = row(day, normalizeOpenAiModel(x.model ?? "unknown"));
      r.requests += x.num_model_requests ?? 0; r.inputTokens += x.input_tokens ?? 0; r.outputTokens += x.output_tokens ?? 0;
    }
  }
  for (const b of costs) {
    const day = isoDay(new Date(b.start_time * 1000));
    for (const x of b.results ?? []) row(day, normalizeOpenAiModel(x.line_item ?? "unknown")).costUsd += Number(x.amount?.value ?? 0);
  }
  ctx.read(usage.length + costs.length);
  return [...rows.values()];
}

export async function fetchOpenRouterUsage(ctx: JobContext, key: string, sinceDay: string): Promise<ProviderUsageRow[]> {
  const h = { authorization: `Bearer ${key}` };
  const body: any = await getJson(`${OPENROUTER}/activity`, { headers: h, fetchImpl: ctx.fetchImpl, retry: ctx.retry });
  const rows = new Map<string, ProviderUsageRow>();
  for (const a of body.data ?? []) {
    const day = String(a.date ?? "").slice(0, 10);
    if (!day || day < sinceDay) continue;
    const model = String(a.model ?? a.model_permaslug ?? "unknown");
    const k = `${day}|${model}`;
    const r = rows.get(k) ?? { provider: "openrouter" as const, day, model, requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    r.requests += Number(a.requests ?? 0); r.inputTokens += Number(a.prompt_tokens ?? 0); r.outputTokens += Number(a.completion_tokens ?? 0);
    r.costUsd += Number(a.usage ?? 0);
    rows.set(k, r);
  }
  ctx.read((body.data ?? []).length);
  try {
    const credits: any = await getJson(`${OPENROUTER}/credits`, { headers: h, fetchImpl: ctx.fetchImpl, retry: { ...ctx.retry, retries: 1 } });
    const d = credits.data ?? {};
    ctx.log("info", "OpenRouter credits", { totalCredits: d.total_credits, totalUsage: d.total_usage });
  } catch (e) { ctx.log("warn", "OpenRouter credits lookup failed", { error: (e as Error).message }); }
  return [...rows.values()];
}

/** Joins provider rows with app-recorded spend; app-only rows appear with zero provider usage so gaps are visible. */
export function reconcile(provider: ProviderUsageRow[], recorded: Array<{ provider: string; day: string; model: string; costUsd: number; calls: number }>, providers: string[]): ReconciledUsageRow[] {
  const out = new Map<string, ReconciledUsageRow>();
  for (const p of provider) out.set(`${p.provider}|${p.day}|${p.model}`, { ...p, recordedCostUsd: 0, recordedCalls: 0 });
  for (const r of recorded) {
    if (!providers.includes(r.provider)) continue;
    const k = `${r.provider}|${r.day}|${r.model}`;
    const row = out.get(k) ?? { provider: r.provider as "openai" | "openrouter", day: r.day, model: r.model, requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, recordedCostUsd: 0, recordedCalls: 0 };
    row.recordedCostUsd += r.costUsd; row.recordedCalls += r.calls;
    out.set(k, row);
  }
  return [...out.values()].sort((a, b) => (a.day + a.provider + a.model).localeCompare(b.day + b.provider + b.model));
}

export const aiUsageJob: JobDef = {
  id: "ai-usage",
  label: "AI usage",
  description: "OpenRouter and OpenAI usage + cost by day and model, reconciled with suggestions recorded here.",
  missingEnv: c => (c.OPENAI_ADMIN_KEY || c.OPENROUTER_API_KEY ? [] : ["OPENROUTER_API_KEY or OPENAI_ADMIN_KEY"]),
  async run(ctx) {
    const today = isoDay(ctx.now);
    const wm = await ctx.repo.getWatermark(ctx.orgId, "ai-usage");
    const since = typeof ctx.params.from === "string" ? ctx.params.from : wm ? addDays(wm, -2) : addDays(today, -30);
    const rows: ProviderUsageRow[] = [];
    const providers: string[] = [];
    if (ctx.config.OPENROUTER_API_KEY) {
      ctx.progress({ phase: "OpenRouter activity" });
      providers.push("openrouter");
      rows.push(...await fetchOpenRouterUsage(ctx, ctx.config.OPENROUTER_PROVISIONING_KEY ?? ctx.config.OPENROUTER_API_KEY, since));
    }
    if (ctx.config.OPENAI_ADMIN_KEY) {
      ctx.progress({ phase: "OpenAI usage + costs" });
      providers.push("openai");
      rows.push(...await fetchOpenAiUsage(ctx, ctx.config.OPENAI_ADMIN_KEY, since));
    }
    const merged = reconcile(rows, await ctx.repo.recordedAiUsage(ctx.orgId, since), providers);
    ctx.progress({ phase: "Saving", done: 0, total: merged.length });
    const r = await ctx.repo.upsertProviderUsage(ctx.orgId, merged);
    ctx.wrote(r.inserted + r.updated);
    const drift = merged.filter(m => Math.abs(m.costUsd - m.recordedCostUsd) > Math.max(0.01, m.costUsd * 0.05));
    if (drift.length) ctx.log("warn", `${drift.length} day/model rows differ from recorded spend by >5%`, { examples: drift.slice(0, 5).map(d => ({ provider: d.provider, day: d.day, model: d.model, provider_usd: +d.costUsd.toFixed(6), recorded_usd: +d.recordedCostUsd.toFixed(6) })) });
    ctx.log("info", `Synced ${merged.length} day/model rows since ${since}`, { providers });
    if (!ctx.dryRun) await ctx.repo.setWatermark(ctx.orgId, "ai-usage", addDays(today, -1));
    ctx.progress({ phase: "Done", done: merged.length, total: merged.length });
  }
};
