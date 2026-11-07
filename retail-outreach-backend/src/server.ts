import { buildApp, twilioFetcherOf } from "./app.js";
import { loadConfigOrExit } from "./config.js";
import { createSuggestionProvider } from "./providers/ai.js";
import { primaryProvider, refreshOpenRouterCatalog } from "./ai/models.js";
import { createMessageProvider } from "./providers/messaging.js";
import { reconcileSmsCosts } from "./metrics/smsCost.js";
import { createStore } from "./store/index.js";
import { createSync } from "./sync/index.js";

const config = loadConfigOrExit();
const store = await createStore(config);
const queue = config.DELIVERY_MODE === "queue"
  ? await import("./queue.js").then(m => m.createDeliveryQueue(config.REDIS_URL))
  : null;

// Data sync: the scheduler is DB-backed (SKIP LOCKED claims), so running it on every API instance is safe.
const sync = await createSync(config, store, { info: (o, m) => app.log.info(o, m), warn: (o, m) => app.log.warn(o, m), error: (o, m) => app.log.error(o, m) });
const messenger = createMessageProvider(config, { log: line => app.log.info(line) });
const app = await buildApp({
  config, store,
  suggestions: createSuggestionProvider({
    apiKey: config.OPENAI_API_KEY, openrouterKey: config.OPENROUTER_API_KEY, aiProvider: config.AI_PROVIDER, model: config.OPENAI_MODEL,
    appUrl: config.APP_URL, appName: config.OPENROUTER_APP_NAME,
    onError: e => app.log.warn({ err: e }, "AI suggestion failed; using rules fallback")
  }),
  messenger,
  enqueueDelivery: queue ? id => queue.enqueue(id) : undefined,
  sync
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  const timer = setTimeout(() => { app.log.error("graceful shutdown timed out; forcing exit"); process.exit(1); }, config.SHUTDOWN_TIMEOUT_MS);
  timer.unref();
  try {
    sync.scheduler.stop();
    await app.close(); // stops accepting connections, waits for in-flight requests
    await sync.runner.drain(); // let running sync jobs finish (bounded by SHUTDOWN_TIMEOUT_MS; a killed run is reaped by its stale heartbeat)
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

if (config.SYNC_SCHEDULER) {
  sync.scheduler.start();
  app.log.info({ intervalSeconds: config.SYNC_SCHEDULER_INTERVAL_SECONDS }, "data sync scheduler started");
}
