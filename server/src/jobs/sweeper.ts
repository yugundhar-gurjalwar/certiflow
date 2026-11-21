import { and, asc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { runEscalations } from "../services/escalation.js";
import { enqueueGenerate, enqueueSend } from "./queues.js";

const { certificates, deliveries } = schema;

/**
 * Self-healing loop. It re-derives outstanding work from the database, so the system converges even if:
 *  - Redis was restarted and queued jobs vanished
 *  - a worker crashed while holding a delivery ("SENDING")
 *  - a delayed retry job was lost
 * Everything it does is idempotent, so running it on every worker instance is harmless.
 */
export async function sweepOnce(now = new Date()) {
  // 1. Claims abandoned by a crashed worker go back to RETRY. (Idempotency-Key makes the re-send safe.)
  const stale = await db.update(deliveries)
    .set({ status: "RETRY", nextAttemptAt: now, lockedAt: null, updatedAt: now, lastError: "worker crashed or timed out mid-send; re-queued" })
    .where(and(eq(deliveries.status, "SENDING"), lt(deliveries.lockedAt, new Date(now.getTime() - config.STALE_CLAIM_MS))))
    .returning({ id: deliveries.id });

  // 2. Certificates still PENDING shortly after approval -> (re)enqueue generation.
  const pendingCerts = await db.select({ id: certificates.id }).from(certificates)
    .where(and(eq(certificates.status, "PENDING"), lt(certificates.createdAt, new Date(now.getTime() - 5_000)))).orderBy(asc(certificates.createdAt)).limit(1000);
  await Promise.all(pendingCerts.map((c) => enqueueGenerate(c.id)));

  // 3. ISSUED certificates without a finished delivery whose attempt is due.
  const due = await db.select({ id: deliveries.id }).from(deliveries)
    .where(and(inArray(deliveries.status, ["QUEUED", "RETRY"]), lte(deliveries.nextAttemptAt, now))).orderBy(asc(deliveries.nextAttemptAt)).limit(1000);
  await Promise.all(due.map((d) => enqueueSend(d.id)));

  // 4. Stuck batches.
  const escalated = await runEscalations(now);

  const summary = { staleClaims: stale.length, pendingCerts: pendingCerts.length, dueDeliveries: due.length, escalated };
  if (stale.length || pendingCerts.length || due.length || escalated) logger.info(summary, "sweep");
  return summary;
}

export { sql };
