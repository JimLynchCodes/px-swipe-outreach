/**
 * AI model catalog + versioned price table.
 *
 * Adding a provider (e.g. Anthropic): add a `ProviderId`, an entry in PROVIDERS (how to tell it's configured),
 * its models below, and a SuggestionProvider implementation registered in createSuggestionProvider().
 * Models whose provider isn't configured are listed as unavailable and fall back to rules.
 */
export type ProviderId = "rules" | "openai";

/** USD per 1M tokens. Bump PRICE_TABLE_VERSION whenever prices change; usage rows store the version they were priced with. */
export const PRICE_TABLE_VERSION = "2026-11-07";

export type ModelInfo = {
  id: string;
  provider: ProviderId;
  label: string;
  /** Price per 1M tokens (USD). */
  inputPerM: number;
  outputPerM: number;
  /** Reasoning models (GPT-5 family) reject a custom temperature. */
  reasoning?: boolean;
};

export const RULES_MODEL = "rules";
/** Cheapest capable OpenAI chat model on the current price list (Nov 2026). */
export const DEFAULT_AI_MODEL = "gpt-4o-mini";

export const MODELS: ModelInfo[] = [
  { id: "gpt-4o-mini", provider: "openai", label: "GPT-4o mini", inputPerM: 0.15, outputPerM: 0.6 },
  { id: "gpt-5.4-nano", provider: "openai", label: "GPT-5.4 nano", inputPerM: 0.2, outputPerM: 1.25, reasoning: true },
  { id: "gpt-5-mini", provider: "openai", label: "GPT-5 mini", inputPerM: 0.25, outputPerM: 2.0, reasoning: true },
  { id: "gpt-4.1-mini", provider: "openai", label: "GPT-4.1 mini", inputPerM: 0.4, outputPerM: 1.6 },
  { id: "gpt-5.4-mini", provider: "openai", label: "GPT-5.4 mini", inputPerM: 0.75, outputPerM: 4.5, reasoning: true },
  { id: RULES_MODEL, provider: "rules", label: "Rules only (no AI)", inputPerM: 0, outputPerM: 0 }
];
export const MODEL_IDS = MODELS.map(m => m.id) as [string, ...string[]];
export const modelInfo = (id: string) => MODELS.find(m => m.id === id);

export const PROVIDERS: Record<ProviderId, { label: string; configured: (c: { OPENAI_API_KEY?: string }) => boolean; missingNote: string }> = {
  rules: { label: "Built-in rules", configured: () => true, missingNote: "" },
  openai: { label: "OpenAI", configured: c => Boolean(c.OPENAI_API_KEY), missingNote: "Set OPENAI_API_KEY on the server to enable OpenAI models. Until then suggestions use rules." }
};

/** Short cost hint, e.g. "~$0.02 per 100 suggestions", from ~700 input + ~150 output tokens per suggestion. */
export function costHint(m: ModelInfo): string {
  if (m.provider === "rules") return "Free";
  const per100 = (700 * m.inputPerM + 150 * m.outputPerM) / 1e6 * 100;
  return `~$${per100 < 0.1 ? per100.toFixed(3) : per100.toFixed(2)} per 100 suggestions`;
}

/** USD for one call, unrounded (sub-cent precision is kept; round only for display). */
export function costUsd(modelId: string, inputTokens: number, outputTokens: number): number {
  const m = modelInfo(modelId);
  if (!m) return 0;
  return (inputTokens * m.inputPerM + outputTokens * m.outputPerM) / 1e6;
}

export function listModels(config: { OPENAI_API_KEY?: string }) {
  return MODELS.map(m => {
    const available = PROVIDERS[m.provider].configured(config);
    return {
      id: m.id, label: m.label, provider: m.provider, providerLabel: PROVIDERS[m.provider].label,
      inputPerM: m.inputPerM, outputPerM: m.outputPerM, costHint: costHint(m), available,
      note: available ? null : PROVIDERS[m.provider].missingNote
    };
  });
}
