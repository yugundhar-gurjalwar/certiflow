import { schema, type Executor } from "../db/client.js";

export type Topic =
  | "batch.submitted" | "batch.advanced" | "batch.sent_back" | "batch.rejected" | "batch.edited"
  | "batch.approved" | "certificate.issued" | "certificate.cancelled" | "delivery.updated" | "escalation.raised";

/**
 * Transactional outbox: the event row is written in the SAME transaction as the state change.
 * A relay process later turns rows into queue jobs. So "state changed but event lost" and
 * "event sent but state rolled back" are both impossible.
 */
export async function emit(tx: Executor, topic: Topic, aggregateId: string, payload: Record<string, unknown> = {}, requestId?: string | null) {
  await tx.insert(schema.outbox).values({ topic, aggregateId, payload, requestId: requestId ?? null });
}
