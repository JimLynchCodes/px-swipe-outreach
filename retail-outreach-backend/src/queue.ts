import IORedis from "ioredis";
import { Queue } from "bullmq";
import { config } from "./config.js";

export const redis = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });
export const deliveryQueue = new Queue("message-delivery", { connection: redis });
