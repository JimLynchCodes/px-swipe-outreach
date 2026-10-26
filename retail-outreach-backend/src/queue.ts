import { Queue } from "bullmq";
import { Redis } from "ioredis";

export const QUEUE_NAME = "message-delivery";

export function createRedis(url: string) {
  return new Redis(url, { maxRetriesPerRequest: null });
}

export function createDeliveryQueue(url: string) {
  const connection = createRedis(url);
  const queue = new Queue(QUEUE_NAME, { connection });
  return {
    async enqueue(deliveryId: string) {
      await queue.add("send", { deliveryId }, {
        jobId: deliveryId, attempts: 5, backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: 1000, removeOnFail: 5000
      });
    },
    async close() { await queue.close(); await connection.quit(); }
  };
}
