import { modelInfo, PRICE_TABLE_VERSION } from "../ai/models.js";
import type { AiUsageRow, SendRow, SmsCostRow } from "./types.js";

export type ModelCost = {
  model: string; label: string; aiCalls: number; inputTokens: number; outputTokens: number; costUsd: number;
  smsSent: number; emailSent: number; messagesSent: number;
};
/** Twilio spend for a period. costUsd includes the flat number fee (numberFeesUsd) when configured. */
export type TwilioCost = { costUsd: number; texts: number; segments: number; estimatedTexts: number; numberFeesUsd: number };
export type CostReport = {
  year: number; priceTableVersion: string; demo: boolean;
  ytd: { costUsd: number; messagesSent: number; aiCalls: number; byModel: ModelCost[]; twilio: TwilioCost; combinedUsd: number };
  months: Array<{ month: string; models: ModelCost[]; total: Omit<ModelCost, "model" | "label">; twilio: TwilioCost; combinedUsd: number }>;
  /** Flat monthly phone-number fee applied (0 = off). */
  numberMonthlyFeeUsd: number;
};
const noTwilio = (): TwilioCost => ({ costUsd: 0, texts: 0, segments: 0, estimatedTexts: 0, numberFeesUsd: 0 });

const monthKey = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };
const empty = (model: string): ModelCost => ({ model, label: modelInfo(model)?.label ?? model, aiCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, smsSent: 0, emailSent: 0, messagesSent: 0 });
const sum = (rows: ModelCost[]) => rows.reduce((t, r) => ({
  aiCalls: t.aiCalls + r.aiCalls, inputTokens: t.inputTokens + r.inputTokens, outputTokens: t.outputTokens + r.outputTokens,
  costUsd: t.costUsd + r.costUsd, smsSent: t.smsSent + r.smsSent, emailSent: t.emailSent + r.emailSent, messagesSent: t.messagesSent + r.messagesSent
}), { aiCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, smsSent: 0, emailSent: 0, messagesSent: 0 });
const byCost = (a: ModelCost, b: ModelCost) => b.costUsd - a.costUsd || b.aiCalls - a.aiCalls || a.model.localeCompare(b.model);

/**
 * Year-to-date AI cost per month and model. AI calls/tokens/cost come from ai_usage (cost priced at call time, so a
 * later price change doesn't rewrite history); messages sent per model come from the send ledger (the model that
 * wrote the suggestion that was sent). Rules-only calls cost $0.
 */
export function costReport(usage: AiUsageRow[], sends: SendRow[], now = new Date(),
  opts: { smsCosts?: SmsCostRow[]; numberMonthlyFeeUsd?: number } = {}): CostReport {
  const year = now.getFullYear();
  const inYear = (iso: string) => new Date(iso).getFullYear() === year && Date.parse(iso) <= now.getTime();
  const months = new Map<string, Map<string, ModelCost>>();
  const cell = (iso: string, model: string) => {
    const m = months.get(monthKey(iso)) ?? new Map<string, ModelCost>();
    months.set(monthKey(iso), m);
    const c = m.get(model) ?? empty(model);
    m.set(model, c);
    return c;
  };
  let demo = false;
  for (const u of usage) {
    if (!inYear(u.createdAt)) continue;
    demo ||= u.isDemo;
    const c = cell(u.createdAt, u.model);
    c.aiCalls++; c.inputTokens += u.inputTokens; c.outputTokens += u.outputTokens; c.costUsd += u.costUsd;
  }
  for (const s of sends) {
    if (!inYear(s.createdAt)) continue;
    demo ||= s.isDemo;
    const c = cell(s.createdAt, s.model);
    if (s.channel === "sms") c.smsSent++; else c.emailSent++;
    c.messagesSent++;
  }
  // Twilio spend (log-provider rows are $0 and not counted as texts billed).
  const twilio = new Map<string, TwilioCost>();
  for (const c of opts.smsCosts ?? []) {
    if (!inYear(c.createdAt) || c.provider !== "twilio") continue;
    demo ||= c.isDemo;
    const k = monthKey(c.createdAt);
    if (!months.has(k)) months.set(k, new Map());
    const t = twilio.get(k) ?? noTwilio();
    twilio.set(k, t);
    t.costUsd += c.priceUsd; t.texts++; t.segments += c.segments; if (c.estimated) t.estimatedTexts++;
  }
  const fee = opts.numberMonthlyFeeUsd ?? 0;
  if (fee > 0) for (const t of twilio.values()) { t.numberFeesUsd = fee; t.costUsd += fee; }
  const monthRows = [...months.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([month, m]) => {
    const models = [...m.values()].sort(byCost);
    const total = sum(models), tw = twilio.get(month) ?? noTwilio();
    return { month, models, total, twilio: tw, combinedUsd: total.costUsd + tw.costUsd };
  });
  const ytdByModel = new Map<string, ModelCost>();
  for (const { models } of monthRows) for (const r of models) {
    const t = ytdByModel.get(r.model) ?? empty(r.model);
    ytdByModel.set(r.model, { ...t, ...Object.fromEntries(Object.entries(sum([t, r]))) } as ModelCost);
  }
  const byModel = [...ytdByModel.values()].sort(byCost);
  const t = sum(byModel);
  const tw = monthRows.reduce((a, m) => ({ costUsd: a.costUsd + m.twilio.costUsd, texts: a.texts + m.twilio.texts, segments: a.segments + m.twilio.segments,
    estimatedTexts: a.estimatedTexts + m.twilio.estimatedTexts, numberFeesUsd: a.numberFeesUsd + m.twilio.numberFeesUsd }), noTwilio());
  return { year, priceTableVersion: PRICE_TABLE_VERSION, demo, numberMonthlyFeeUsd: fee,
    ytd: { costUsd: t.costUsd, messagesSent: t.messagesSent, aiCalls: t.aiCalls, byModel, twilio: tw, combinedUsd: t.costUsd + tw.costUsd }, months: monthRows };
}
