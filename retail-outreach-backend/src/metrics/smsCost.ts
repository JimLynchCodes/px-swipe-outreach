/**
 * Twilio spend tracking. Every outbound SMS gets an sms_costs row at send time:
 *   - log provider: $0 (nothing is sent);
 *   - twilio: Twilio's price if already known (rare), else segments × TWILIO_SMS_PRICE_ESTIMATE flagged `estimated`.
 * The actual price replaces the estimate via the StatusCallback webhook (we fetch the message on a final status) and a
 * periodic reconcile job (catches missed callbacks; Twilio can take minutes to price a message).
 */
import type { FastifyBaseLogger } from "fastify";
import type { MessageProvider, OutboundMessage, SendResult, TwilioMessage } from "../providers/messaging.js";
import { smsSegments, twilioPriceUsd } from "../providers/messaging.js";
import type { OutreachStore } from "../store/types.js";

type Log = Pick<FastifyBaseLogger, "warn" | "info">;

/** Wraps the real provider; records SMS cost rows without ever failing a send. */
export class CostTrackingMessenger implements MessageProvider {
  readonly name: string;
  constructor(private inner: MessageProvider, private store: OutreachStore, private opts: { estimatePerSegment: number; log?: Log }) { this.name = inner.name; }
  async send(msg: OutboundMessage): Promise<SendResult> {
    const res = await this.inner.send(msg);
    if (msg.channel === "sms" && msg.orgId) {
      const provider = res.provider === "twilio" ? "twilio" : "log";
      const segments = res.segments ?? smsSegments(msg.message);
      const actual = provider === "twilio" ? res.priceUsd ?? null : 0;
      await this.store.recordSmsCost(msg.orgId, {
        provider, messageSid: provider === "twilio" ? res.providerMessageId : null, segments,
        priceUsd: actual ?? Number((segments * this.opts.estimatePerSegment).toFixed(6)), estimated: actual === null, status: "sent"
      }).catch(e => this.opts.log?.warn({ err: e }, "failed to record SMS cost"));
    }
    return res;
  }
}

export type MessageFetcher = (sid: string) => Promise<TwilioMessage>;

/** Applies a fetched Twilio message to its cost row. Returns true once the actual price is stored. */
export async function applyTwilioMessage(store: OutreachStore, m: TwilioMessage): Promise<boolean> {
  const price = twilioPriceUsd(m);
  const segments = Number(m.numSegments) || undefined;
  await store.updateSmsCost(m.sid, { ...(price !== null ? { priceUsd: price } : {}), ...(segments ? { segments } : {}), ...(m.status ? { status: m.status } : {}) });
  return price !== null;
}

/** Fetches prices for Twilio rows still on an estimate (≥2 min old, ≤30 days). */
export async function reconcileSmsCosts(store: OutreachStore, fetchMessage: MessageFetcher, opts: { now?: Date; limit?: number; log?: Log } = {}) {
  const now = (opts.now ?? new Date()).getTime();
  const pending = await store.listEstimatedSmsCosts({
    olderThanIso: new Date(now - 2 * 60_000).toISOString(), newerThanIso: new Date(now - 30 * 86_400_000).toISOString(), limit: opts.limit ?? 100
  });
  let priced = 0, failed = 0;
  for (const { messageSid } of pending) {
    try { if (await applyTwilioMessage(store, await fetchMessage(messageSid))) priced++; }
    catch (e) { failed++; opts.log?.warn({ err: e, messageSid }, "Twilio price fetch failed"); }
  }
  return { checked: pending.length, priced, failed };
}
