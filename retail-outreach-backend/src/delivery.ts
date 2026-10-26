import type { MessageProvider } from "./providers/messaging.js";
import type { OutreachStore } from "./store/types.js";

/** Sends one queued delivery and records the outcome. Shared by inline mode and the BullMQ worker. */
export async function processDelivery(store: OutreachStore, messenger: MessageProvider, deliveryId: string) {
  const d = await store.getDelivery(deliveryId);
  if (!d) throw new Error(`Delivery ${deliveryId} not found`);
  if (d.status === "sent" || d.status === "delivered") return d;
  await store.updateDelivery(d.id, "sending");
  try {
    const { providerMessageId } = await messenger.send({ channel: d.channel, recipient: d.recipient, message: d.message, subject: d.subject });
    await store.updateDelivery(d.id, "sent", { providerMessageId });
  } catch (e) {
    await store.updateDelivery(d.id, "failed", { error: e instanceof Error ? e.message : "Unknown send error" });
    throw e;
  }
  return (await store.getDelivery(d.id))!;
}
