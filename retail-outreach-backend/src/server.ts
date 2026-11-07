import { buildApp, twilioFetcherOf } from "./app.js";
import { loadConfigOrExit } from "./config.js";
import { createSuggestionProvider } from "./providers/ai.js";
import { primaryProvider, refreshOpenRouterCatalog } from "./ai/models.js";
import { createMessageProvider } from "./providers/messaging.js";
import { reconcileSmsCosts } from "./metrics/smsCost.js";
import { createStore } from "./store/index.js";

const config = loadConfigOrExit();
const store = await createStore(config);
const queue = config.DELIVERY_MODE === "queue"
  ? await import("./queue.js").then(m => m.createDeliveryQueue(config.REDIS_URL))
  : null;

const messenger = createMessageProvider(config, { log: line => app.log.info(line) });
const app = await buildApp({
  config, store,
  suggestions: createSuggestionProvider({
    apiKey: config.OPENAI_API_KEY, openrouterKey: config.OPENROUTER_API_KEY, aiProvider: config.AI_PROVIDER, model: config.OPENAI_MODEL,
    appUrl: config.APP_URL, appName: config.OPENROUTER_APP_NAME,
    onError: e => app.log.warn({ err: e }, "AI suggestion failed; using rules fallback")
  }),
  messenger,
  enqueueDelivery: queue ? id => queue.enqueue(id) : undefined
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  const timer = setTimeout(() => { app.log.error("graceful shutdown timed out; forcing exit"); process.exit(1); }, config.SHUTDOWN_TIMEOUT_MS);
  timer.unref();
  try {
    await app.close(); // stops accepting connections, waits for in-flight requests
    await queue?.close();
    await store.close();
    process.exit(0);
  } catch (e) {
    app.log.error({ err: e }, "error during shutdown");
    process.exit(1);
  }
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", err => { app.log.error({ err }, "unhandled rejection"); });

try {
  await store.ping();
} catch (e) {
  app.log.fatal({ err: e }, "cannot reach the database; check DATABASE_URL");
  process.exit(1);
}
await app.listen({ port: config.PORT, host: config.HOST });
app.log.info(`Outreach API ready (env=${config.NODE_ENV}, auth=${config.AUTH_MODE}, store=${config.DATA_STORE}, delivery=${config.DELIVERY_MODE}, ai=${primaryProvider(config) ?? "rules"}, email=${config.EMAIL_PROVIDER}, sms=${config.SMS_PROVIDER})`);

// Twilio price reconcile: replaces estimated SMS costs with Twilio's actual price (covers missed status callbacks).
const fetchTwilio = twilioFetcherOf(messenger);
if (fetchTwilio && config.TWILIO_RECONCILE_MINUTES > 0) {
  const run = () => reconcileSmsCosts(store, fetchTwilio, { log: app.log })
    .then(r => { if (r.checked) app.log.info(r, "Twilio price reconcile"); })
    .catch(e => app.log.warn({ err: e }, "Twilio price reconcile failed"));
  setInterval(run, config.TWILIO_RECONCILE_MINUTES * 60_000).unref();
  void run();
}

// Refresh OpenRouter prices for the allowlist (and hide models that lost structured-output support) once a day.
if (config.OPENROUTER_API_KEY) {
  const refresh = () => refreshOpenRouterCatalog().then(r => { if (r.refreshed) app.log.info(r, "OpenRouter catalog refreshed"); })
    .catch(e => app.log.warn({ err: e }, "OpenRouter catalog refresh failed; using built-in prices"));
  setInterval(refresh, 6 * 3_600_000).unref();
  void refresh();
}
