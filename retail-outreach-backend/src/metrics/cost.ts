import { modelInfo, PRICE_TABLE_VERSION } from "../ai/models.js";
import type { AiUsageRow, SendRow } from "./types.js";

export type ModelCost = {
  model: string; label: string; aiCalls: number; inputTokens: number; outputTokens: number; costUsd: number;
  smsSent: number; emailSent: number; messagesSent: number;
};
export type CostReport = {
  year: number; priceTableVersion: string; demo: boolean;
  ytd: { costUsd: number; messagesSent: number; aiCalls: number; byModel: ModelCost[] };
  months: Array<{ month: string; models: ModelCost[]; total: Omit<ModelCost, "model" | "label"> }>;
};

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
export function costReport(usage: AiUsageRow[], sends: SendRow[], now = new Date()): CostReport {
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
  const monthRows = [...months.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([month, m]) => {
    const models = [...m.values()].sort(byCost);
    return { month, models, total: sum(models) };
  });
  const ytdByModel = new Map<string, ModelCost>();
  for (const { models } of monthRows) for (const r of models) {
    const t = ytdByModel.get(r.model) ?? empty(r.model);
    ytdByModel.set(r.model, { ...t, ...Object.fromEntries(Object.entries(sum([t, r]))) } as ModelCost);
  }
  const byModel = [...ytdByModel.values()].sort(byCost);
  const t = sum(byModel);
  return { year, priceTableVersion: PRICE_TABLE_VERSION, demo, ytd: { costUsd: t.costUsd, messagesSent: t.messagesSent, aiCalls: t.aiCalls, byModel }, months: monthRows };
}
