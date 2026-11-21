import { Redis } from "ioredis";
import { config } from "./config.js";

/** General-purpose connection (cache, rate limits, publish). */
export const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: true });
redis.on("error", () => { /* logged by health checks; ioredis reconnects by itself */ });

/** BullMQ needs connections with maxRetriesPerRequest=null; create them on demand. */
export function newBlockingConnection(): Redis {
  const r = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  r.on("error", () => {});
  return r;
}
