import { buildApp } from "./app.js";
import { loadConfigOrExit } from "./config.js";
import { createSuggestionProvider } from "./providers/ai.js";
import { createMessageProvider } from "./providers/messaging.js";
import { createStore } from "./store/index.js";

const config = loadConfigOrExit();
const store = await createStore(config);
const queue = config.DELIVERY_MODE === "queue"
  ? await import("./queue.js").then(m => m.createDeliveryQueue(config.REDIS_URL))
  : null;

const app = await buildApp({
  config, store,
  suggestions: createSuggestionProvider({
    apiKey: config.OPENAI_API_KEY, model: config.OPENAI_MODEL,
    onError: e => app.log.warn({ err: e }, "AI suggestion failed; using rules fallback")
  }),
  messenger: createMessageProvider({ sms: config.SMS_PROVIDER, email: config.EMAIL_PROVIDER }, line => app.log.info(line)),
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
app.log.info(`Outreach API ready (env=${config.NODE_ENV}, auth=${config.AUTH_MODE}, store=${config.DATA_STORE}, delivery=${config.DELIVERY_MODE}, ai=${config.OPENAI_API_KEY ? "openai" : "rules"})`);
