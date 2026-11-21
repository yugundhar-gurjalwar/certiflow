import { Queue } from "bullmq";
import { newBlockingConnection } from "../redis.js";

/**
 * Queue choice (README "Key decisions"): BullMQ on Redis. Redis is already in the stack for caching and
 * pub/sub, BullMQ gives delayed jobs, concurrency, dedupe by jobId and a stable Node API, and it is
 * operationally one less moving part than adding RabbitMQ/Kafka for this volume (~30k jobs/hour peak).
 *
 * IMPORTANT design rule: Redis is only a *hint* that something needs doing. The truth lives in Postgres
 * (outbox rows, PENDING certificates, due deliveries) and the sweeper re-derives the work from there. If Redis
 * is wiped, nothing is lost, only delayed by one sweep interval.
 */
export const QUEUE_NAMES = { events: "cf-events", generate: "cf-generate", send: "cf-send" } as const;

let connection: ReturnType<typeof newBlockingConnection> | undefined;
const conn = () => (connection ??= newBlockingConnection());

const defaultJobOptions = {
  removeOnComplete: true, // so the same jobId can be enqueued again later (idempotent handlers make that safe)
  removeOnFail: true,
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 1000 },
};

const cache = new Map<string, Queue>();
export function getQueue(name: string): Queue {
  let q = cache.get(name);
  if (!q) { q = new Queue(name, { connection: conn(), defaultJobOptions }); cache.set(name, q); }
  return q;
}

export const enqueueGenerate = (certificateId: string) =>
  getQueue(QUEUE_NAMES.generate).add("generate", { certificateId }, { jobId: `gen_${certificateId}` });

export const enqueueSend = (deliveryId: string, delayMs = 0) =>
  getQueue(QUEUE_NAMES.send).add("send", { deliveryId }, { jobId: `send_${deliveryId}${delayMs ? `_${Date.now()}` : ""}`, delay: delayMs });

export async function closeQueues() {
  await Promise.all([...cache.values()].map((q) => q.close()));
  cache.clear();
  connection?.disconnect();
  connection = undefined;
}
