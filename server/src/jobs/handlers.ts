import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { logger } from "../logger.js";
import { attemptDelivery } from "../services/deliveries.js";
import { generateCertificate, invalidateVerifyCache } from "../services/certificates.js";
import { enqueueGenerate, enqueueSend } from "./queues.js";

const { certificates, deliveries } = schema;

export interface DomainEvent { outboxId: number; topic: string; aggregateId: string; payload: Record<string, unknown>; requestId?: string | null }

/** Reacts to committed domain events. Every branch is idempotent. */
export async function handleDomainEvent(ev: DomainEvent): Promise<void> {
  const log = logger.child({ topic: ev.topic, aggregateId: ev.aggregateId, requestId: ev.requestId, outboxId: ev.outboxId });
  switch (ev.topic) {
    case "batch.approved": {
      // Fan out: one generate job per certificate. jobId = gen_<certId> dedupes repeats.
      const pending = await db.select({ id: certificates.id }).from(certificates).where(and(eq(certificates.batchId, ev.aggregateId), eq(certificates.status, "PENDING")));
      await Promise.all(pending.map((c) => enqueueGenerate(c.id)));
      log.info({ certificates: pending.length }, "fan-out certificate generation");
      break;
    }
    case "certificate.issued": {
      const [d] = await db.select({ id: deliveries.id }).from(deliveries).where(eq(deliveries.certificateId, ev.aggregateId));
      if (d) await enqueueSend(d.id);
      break;
    }
    case "certificate.cancelled":
      await invalidateVerifyCache(String(ev.payload.number), true); // repeats the post-commit invalidation (idempotent)
      break;
    default:
      break; // other topics exist for the audit/outbox trail and live UI; nothing else to do
  }
}

export async function handleGenerate(data: { certificateId: string }) {
  const r = await generateCertificate(data.certificateId);
  logger.info({ certificateId: data.certificateId, result: r }, "generate job done");
}

export async function handleSend(data: { deliveryId: string }) {
  const out = await attemptDelivery(data.deliveryId);
  if (out.result === "retry") await enqueueSend(data.deliveryId, out.delayMs);
}
