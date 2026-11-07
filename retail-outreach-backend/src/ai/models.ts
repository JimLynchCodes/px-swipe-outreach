/**
 * AI model catalog + versioned price table.
 *
 * Adding a provider (e.g. Anthropic): add a `ProviderId`, an entry in PROVIDERS (how to tell it's configured),
 * its models below, and a SuggestionProvider implementation registered in createSuggestionProvider().
 * Models whose provider isn't configured are listed as unavailable and fall back to rules.
 */
export type ProviderId = "rules" | "openai" | "openrouter";

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
  /** Same model on the other provider (OpenAI direct ↔ OpenRouter), used for routing and fallback. */
  alias?: string;
};

export const RULES_MODEL = "rules";
/** Default: OpenAI's GPT-4o mini through OpenRouter (cheap, supports JSON-schema structured outputs). */
export const DEFAULT_AI_MODEL = "openai/gpt-4o-mini";

/**
 * Allowlist. OpenRouter ids/prices verified against https://openrouter.ai/api/v1/models (Nov 2026); every OpenRouter
 * model here lists `structured_outputs` in supported_parameters. Prices are refreshed at runtime (refreshOpenRouterCatalog)
 * and exact per-call cost comes from OpenRouter's usage accounting; this table is the fallback.
 */
export const MODELS: ModelInfo[] = [
  { id: "openai/gpt-4o-mini", provider: "openrouter", label: "GPT-4o mini (OpenAI)", inputPerM: 0.15, outputPerM: 0.6, alias: "gpt-4o-mini" },
  { id: "google/gemini-2.5-flash-lite", provider: "openrouter", label: "Gemini 2.5 Flash-Lite (Google)", inputPerM: 0.1, outputPerM: 0.4 },
  { id: "anthropic/claude-haiku-5.5", provider: "openrouter", label: "Claude Haiku 5.5 (Anthropic)", inputPerM: 0.1, outputPerM: 0.5 },
  { id: "mistralai/mistral-small-3.2-24b-instruct", provider: "openrouter", label: "Mistral Small 3.2 (open weights)", inputPerM: 0.075, outputPerM: 0.2 },
  { id: "deepseek/deepseek-chat-v3.1", provider: "openrouter", label: "DeepSeek V3.1 (open weights)", inputPerM: 0.25, outputPerM: 0.95 },
  { id: "openai/gpt-5-mini", provider: "openrouter", label: "GPT-5 mini (OpenAI)", inputPerM: 0.25, outputPerM: 2.0, reasoning: true, alias: "gpt-5-mini" },
  { id: "openai/gpt-4.1-mini", provider: "openrouter", label: "GPT-4.1 mini (OpenAI)", inputPerM: 0.4, outputPerM: 1.6, alias: "gpt-4.1-mini" },
  // Direct OpenAI (optional fallback provider; also how orgs saved before OpenRouter keep working).
  { id: "gpt-4o-mini", provider: "openai", label: "GPT-4o mini (direct OpenAI)", inputPerM: 0.15, outputPerM: 0.6, alias: "openai/gpt-4o-mini" },
  { id: "gpt-5.4-nano", provider: "openai", label: "GPT-5.4 nano (direct OpenAI)", inputPerM: 0.2, outputPerM: 1.25, reasoning: true },
  { id: "gpt-5-mini", provider: "openai", label: "GPT-5 mini (direct OpenAI)", inputPerM: 0.25, outputPerM: 2.0, reasoning: true, alias: "openai/gpt-5-mini" },
  { id: "gpt-4.1-mini", provider: "openai", label: "GPT-4.1 mini (direct OpenAI)", inputPerM: 0.4, outputPerM: 1.6, alias: "openai/gpt-4.1-mini" },
  { id: "gpt-5.4-mini", provider: "openai", label: "GPT-5.4 mini (direct OpenAI)", inputPerM: 0.75, outputPerM: 4.5, reasoning: true },
  { id: RULES_MODEL, provider: "rules", label: "None", inputPerM: 0, outputPerM: 0 }
];
export const MODEL_IDS = MODELS.map(m => m.id) as [string, ...string[]];
export const modelInfo = (id: string) => MODELS.find(m => m.id === id);

export type AiKeys = { OPENAI_API_KEY?: string; OPENROUTER_API_KEY?: string; AI_PROVIDER?: "openrouter" | "openai" };

export const PROVIDERS: Record<ProviderId, { label: string; configured: (c: AiKeys) => boolean; missingNote: string }> = {
  rules: { label: "Built-in rules", configured: () => true, missingNote: "" },
  openrouter: { label: "OpenRouter", configured: c => Boolean(c.OPENROUTER_API_KEY), missingNote: "Set OPENROUTER_API_KEY on the server to enable this model. Until then suggestions use rules." },
  openai: { label: "OpenAI", configured: c => Boolean(c.OPENAI_API_KEY), missingNote: "Set OPENAI_API_KEY (or OPENROUTER_API_KEY) on the server to enable this model. Until then suggestions use rules." }
};

/** The primary AI provider: AI_PROVIDER if set, else OpenRouter when its key is set, else OpenAI when its key is set. */
export function primaryProvider(c: AiKeys): "openrouter" | "openai" | null {
  if (c.AI_PROVIDER) return PROVIDERS[c.AI_PROVIDER].configured(c) ? c.AI_PROVIDER : null;
  return c.OPENROUTER_API_KEY ? "openrouter" : c.OPENAI_API_KEY ? "openai" : null;
}

export type Route = { provider: "openrouter" | "openai"; model: string };
/**
 * Where a model can run, in order: its own provider and its alias on the other one, primary provider first.
 * E.g. with OpenRouter primary, "gpt-4o-mini" → [openrouter openai/gpt-4o-mini, openai gpt-4o-mini]. [] = rules.
 */
export function routesFor(modelId: string, c: AiKeys): Route[] {
  const m = modelInfo(modelId);
  if (!m || m.provider === "rules") return [];
  const all: Route[] = [{ provider: m.provider, model: m.id }];
  const alias = m.alias ? modelInfo(m.alias) : undefined;
  if (alias && alias.provider !== "rules") all.push({ provider: alias.provider, model: alias.id });
  const primary = primaryProvider(c);
  return all.filter(r => PROVIDERS[r.provider].configured(c)).sort((a, b) => Number(b.provider === primary) - Number(a.provider === primary));
}

/** Short cost hint, e.g. "~$0.02 per 100 suggestions", from ~700 input + ~150 output tokens per suggestion. */
export function costHint(m: ModelInfo): string {
  if (m.provider === "rules") return "Heuristic-based canned suggestions, free";
  const per100 = (700 * m.inputPerM + 150 * m.outputPerM) / 1e6 * 100;
  return `~$${per100 < 0.1 ? per100.toFixed(3) : per100.toFixed(2)} per 100 suggestions`;
}

/** USD for one call, unrounded (sub-cent precision is kept; round only for display). */
export function costUsd(modelId: string, inputTokens: number, outputTokens: number): number {
  const m = modelInfo(modelId);
  if (!m) return 0;
  return (inputTokens * m.inputPerM + outputTokens * m.outputPerM) / 1e6;
}

export function listModels(config: AiKeys) {
  return MODELS.filter(m => !disabled.has(m.id)).map(m => {
    const available = m.provider === "rules" || routesFor(m.id, config).length > 0;
    return {
      id: m.id, label: m.label, provider: m.provider, providerLabel: PROVIDERS[m.provider].label,
      inputPerM: m.inputPerM, outputPerM: m.outputPerM, costHint: costHint(m), available,
      note: available ? null : PROVIDERS[m.provider].missingNote
    };
  });
}

// ── Live OpenRouter catalog (optional): refresh prices of allowlisted models; drop ones without structured outputs ──
const disabled = new Set<string>();
const ORIGINAL_PRICES = new Map(MODELS.map(m => [m.id, [m.inputPerM, m.outputPerM] as const]));
let refreshedAt = 0;
type OrModel = { id: string; pricing?: { prompt?: string; completion?: string }; supported_parameters?: string[] };

/** Fetches https://openrouter.ai/api/v1/models at most once per `ttlMs` and updates the allowlist in place. */
export async function refreshOpenRouterCatalog(opts: { fetchImpl?: typeof fetch; ttlMs?: number; now?: number } = {}) {
  const now = opts.now ?? Date.now();
  if (now - refreshedAt < (opts.ttlMs ?? 24 * 3_600_000)) return { refreshed: false, updated: 0 };
  const res = await (opts.fetchImpl ?? fetch)("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`OpenRouter models: HTTP ${res.status}`);
  const live = new Map(((await res.json()) as { data: OrModel[] }).data.map(m => [m.id, m]));
  let updated = 0;
  for (const m of MODELS.filter(x => x.provider === "openrouter")) {
    const l = live.get(m.id);
    if (!l || !(l.supported_parameters ?? []).includes("structured_outputs")) { disabled.add(m.id); continue; }
    disabled.delete(m.id);
    const perM = (v?: string) => Math.round(Number(v) * 1e12) / 1e6; // $/token → $/1M tokens, float noise removed
    const inP = perM(l.pricing?.prompt), outP = perM(l.pricing?.completion);
    if (Number.isFinite(inP) && Number.isFinite(outP) && (inP !== m.inputPerM || outP !== m.outputPerM)) { m.inputPerM = inP; m.outputPerM = outP; updated++; }
  }
  refreshedAt = now;
  return { refreshed: true, updated, disabled: [...disabled] };
}
/** Test helper. */
export function _resetCatalogCache() {
  refreshedAt = 0; disabled.clear();
  for (const m of MODELS) [m.inputPerM, m.outputPerM] = ORIGINAL_PRICES.get(m.id)!;
}
