import { inArray, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { getQueue, QUEUE_NAMES } from "./queues.js";

/**
 * Outbox relay: moves committed outbox rows onto the queue.
 * FOR UPDATE SKIP LOCKED lets several relays (several worker containers) run side by side without
 * handling the same row. If the process dies after enqueue but before marking, the row is enqueued again with the
 * SAME jobId and every handler is idempotent -> at-least-once delivery, effectively-once effect.
 */
export async function relayOnce(limit = 200): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{ id: number; topic: string; aggregate_id: string; payload: unknown; request_id: string | null }>(
      sql`select id, topic, aggregate_id, payload, request_id from outbox where published_at is null order by id limit ${limit} for update skip locked`,
    );
    if (rows.rows.length === 0) return 0;
    const q = getQueue(QUEUE_NAMES.events);
    await q.addBulk(rows.rows.map((r) => ({
      name: r.topic,
      data: { outboxId: r.id, topic: r.topic, aggregateId: r.aggregate_id, payload: r.payload, requestId: r.request_id },
      opts: { jobId: `ob_${r.id}` },
    })));
    await tx.update(schema.outbox).set({ publishedAt: new Date() }).where(inArray(schema.outbox.id, rows.rows.map((r) => r.id)));
    return rows.rows.length;
  });
}
