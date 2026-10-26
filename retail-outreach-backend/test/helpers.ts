import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { RulesSuggestionProvider, type SuggestionProvider } from "../src/providers/ai.js";
import { ConsoleMessageProvider, type MessageProvider } from "../src/providers/messaging.js";
import { MemoryStore } from "../src/store/memory.js";

export async function makeApp(overrides: { suggestions?: SuggestionProvider; messenger?: MessageProvider } = {}) {
  const config = loadConfig({ NODE_ENV: "test" });
  const store = new MemoryStore();
  const messenger = overrides.messenger ?? new ConsoleMessageProvider(() => {});
  const app = await buildApp({ config, store, suggestions: overrides.suggestions ?? new RulesSuggestionProvider(), messenger, logger: false });
  return { app, store, messenger };
}
