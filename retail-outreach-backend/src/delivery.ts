import type { MessageProvider } from "./providers/messaging.js";
import type { OutreachStore } from "./store/types.js";

/**
 * Sends one queued delivery and records the outcome. Shared by inline mode and the BullMQ worker.
 * Safe to retry: already-sent deliveries are returned as-is, and the suppression list is re-checked
 * immediately before handing off to the provider (a customer may opt out while the job is queued).
 */
export type DeliveryOptions = {
  /** Builds the per-email unsubscribe link + headers (see optout/unsubscribe.ts). */
  unsubscribe?: (deliveryId: string) => { url: string; headers: Record<string, string> };
  /** Reply-To address for the delivery's reply token (routes customer replies into the thread). */
  replyTo?: (token: string | null | undefined) => string | null;
};

export async function processDelivery(store: OutreachStore, messenger: MessageProvider, deliveryId: string, opts: DeliveryOptions = {}) {
  const d = await store.getDelivery(deliveryId);
  if (!d) throw new Error(`Delivery ${deliveryId} not found`);
  if (d.status === "sent" || d.status === "delivered") return d;
  if (await store.isSuppressed(d.orgId, d.channel, d.recipient)) {
    await store.updateDelivery(d.id, "failed", { error: "recipient_suppressed" });
    return (await store.getDelivery(d.id))!;
  }
  await store.updateDelivery(d.id, "sending");
  try {
    // Opt-outs are per channel: only this channel's suppression (checked above) blocks the send.
    const unsub = d.channel === "email" ? opts.unsubscribe?.(d.id) : undefined;
    const message = unsub ? `${d.message}\n\nUnsubscribe: ${unsub.url}` : d.message;
    const { providerMessageId } = await messenger.send({
      channel: d.channel, recipient: d.recipient, message, subject: d.subject, orgId: d.orgId,
      ...(unsub ? { headers: { ...unsub.headers, ...(opts.replyTo?.(d.replyToken) ? { "Reply-To": opts.replyTo(d.replyToken)! } : {}) } } : {})
    });
    await store.updateDelivery(d.id, "sent", { providerMessageId });
  } catch (e) {
    await store.updateDelivery(d.id, "failed", { error: e instanceof Error ? e.message.slice(0, 500) : "Unknown send error" });
    throw e;
  }
  return (await store.getDelivery(d.id))!;
}
