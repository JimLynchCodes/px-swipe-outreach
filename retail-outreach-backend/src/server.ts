import { buildApp } from "./app.js";
import { config } from "./config.js";
import { createSuggestionProvider } from "./providers/ai.js";
import { createMessageProvider } from "./providers/messaging.js";
import { createStore } from "./store/index.js";

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

const shutdown = async () => {
  await app.close();
  await queue?.close();
  await store.close();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await app.listen({ port: config.PORT, host: config.HOST });
app.log.info(`Outreach API ready (store=${config.DATA_STORE}, delivery=${config.DELIVERY_MODE}, ai=${config.OPENAI_API_KEY ? "openai" : "rules"})`);
