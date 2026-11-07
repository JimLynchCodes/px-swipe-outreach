import { Worker } from "bullmq";
import { loadConfigOrExit } from "./config.js";
import { processDelivery } from "./delivery.js";
import { unsubscribeLink } from "./optout/unsubscribe.js";
import { replyToAddress } from "./replies/routes.js";
import { createMessageProvider } from "./providers/messaging.js";
import { createRedis, QUEUE_NAME } from "./queue.js";
import { createStore } from "./store/index.js";
import { CostTrackingMessenger } from "./metrics/smsCost.js";

const config = loadConfigOrExit();
if (config.DATA_STORE !== "postgres") {
  console.error("The worker needs DATA_STORE=postgres (the memory store is per-process). Use DELIVERY_MODE=inline for local demos.");
  process.exit(1);
}

const store = await createStore(config);
// Wrapped so queued SMS sends also record Twilio spend (sms_costs).
const messenger = new CostTrackingMessenger(createMessageProvider(config), store, { estimatePerSegment: config.TWILIO_SMS_PRICE_ESTIMATE });
const worker = new Worker(QUEUE_NAME, job => processDelivery(store, messenger, job.data.deliveryId,
  { unsubscribe: id => unsubscribeLink(config.PUBLIC_API_URL, config.UNSUBSCRIBE_SIGNING_SECRET, id), replyTo: token => replyToAddress(config, token) }),
  { connection: createRedis(config.REDIS_URL), concurrency: 5 });

worker.on("completed", job => console.log(`Delivery job ${job.id} completed`));
// Log ids only: job payloads and provider errors can contain customer contact details.
worker.on("failed", (job, err) => console.error(`Delivery job ${job?.id} failed: ${err.name}`));
console.log("Message delivery worker started");

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, async () => { await worker.close(); await store.close(); process.exit(0); });
}
