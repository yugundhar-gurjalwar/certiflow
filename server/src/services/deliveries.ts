import { and, eq, lt, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { SYSTEM_ACTOR } from "../auth/actor.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { audit } from "./audit.js";
import { publish } from "./realtime.js";
import { sendWhatsApp } from "./whatsapp.js";

const { deliveries, certificates, candidates, batches, courses } = schema;

export function backoffMs(attempt: number): number {
  const exp = Math.min(config.DELIVERY_BACKOFF_MAX_MS, config.DELIVERY_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (0.5 + Math.random() * 0.5)); // jitter, so a recovering provider is not hit by a stampede
}

export type AttemptOutcome =
  | { result: "noop"; reason: string }
  | { result: "sent" | "skipped" | "failed_permanent" | "dead" }
  | { result: "retry"; delayMs: number };

/**
 * One delivery attempt. Safe under duplicates and crashes:
 *  - the claim is an atomic UPDATE ... WHERE status in (QUEUED, RETRY): two workers cannot both claim it
 *  - finishing updates only WHERE status = 'SENDING': a late/duplicate finisher cannot overwrite a newer state
 *  - provider call carries the delivery id as Idempotency-Key: a retry after a timeout cannot double-send
 */
export async function attemptDelivery(deliveryId: string, requestId?: string): Promise<AttemptOutcome> {
  const claimed = await db.update(deliveries)
    .set({ status: "SENDING", attempts: sql`${deliveries.attempts} + 1`, lockedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(deliveries.id, deliveryId), sql`${deliveries.status} in ('QUEUED','RETRY')`, sql`${deliveries.nextAttemptAt} <= now() + interval '1 second'`))
    .returning();
  const d = claimed[0];
  if (!d) return { result: "noop", reason: "not claimable (already sent, in flight, not due, or unknown)" };

  const [row] = await db
    .select({ cert: certificates, cand: candidates, batch: batches, courseName: courses.name })
    .from(certificates)
    .innerJoin(candidates, eq(candidates.id, certificates.candidateId))
    .innerJoin(batches, eq(batches.id, certificates.batchId))
    .innerJoin(courses, eq(courses.code, batches.courseCode))
    .where(eq(certificates.id, d.certificateId));
  if (!row) return { result: "noop", reason: "certificate vanished" };

  const finish = async (status: string, extra: Partial<typeof deliveries.$inferInsert> = {}) => {
    const r = await db.update(deliveries).set({ status, updatedAt: new Date(), lockedAt: null, ...extra })
      .where(and(eq(deliveries.id, d.id), eq(deliveries.status, "SENDING"))).returning({ id: deliveries.id });
    if (r.length) await publish({ type: "delivery.updated", batchId: row.batch.id, certificateId: row.cert.id, centreId: row.batch.centreId, districtId: row.batch.districtId, info: { status } });
    return r.length > 0;
  };

  if (row.cert.status !== "ISSUED") {
    await finish("SKIPPED", { lastError: `certificate is ${row.cert.status}` });
    return { result: "skipped" }; // never send a cancelled (or not-yet-issued) certificate
  }

  const text = `Congratulations ${row.cand.fullName}! Your ${row.courseName} certificate (${row.cert.number}) from Pragati Skills Mission is ready. Download: ${config.PUBLIC_WEB_URL}/c/${row.cert.downloadToken}`;
  const res = await sendWhatsApp({ to: row.cand.phone, text, documentUrl: `${config.PUBLIC_WEB_URL}/c/${row.cert.downloadToken}`, clientRef: d.id });

  if (res.kind === "accepted") {
    await finish("SENT", { providerMessageId: res.providerMessageId, lastError: null });
    logger.info({ deliveryId: d.id, certificateId: row.cert.id, batchId: row.batch.id, attempt: d.attempts, requestId }, "whatsapp accepted");
    return { result: "sent" };
  }
  if (res.kind === "permanent") {
    await finish("FAILED_PERMANENT", { lastError: res.error });
    await db.transaction((tx) => audit(tx, SYSTEM_ACTOR("worker"), "delivery.failed_permanent", { batchId: row.batch.id, certificateId: row.cert.id, details: { error: res.error }, requestId }));
    logger.warn({ deliveryId: d.id, certificateId: row.cert.id, error: res.error }, "whatsapp permanent failure");
    return { result: "failed_permanent" };
  }
  if (d.attempts >= config.DELIVERY_MAX_ATTEMPTS) {
    await finish("DEAD", { lastError: res.error });
    await db.transaction((tx) => audit(tx, SYSTEM_ACTOR("worker"), "delivery.dead", { batchId: row.batch.id, certificateId: row.cert.id, details: { error: res.error, attempts: d.attempts }, requestId }));
    logger.error({ deliveryId: d.id, certificateId: row.cert.id, attempts: d.attempts, error: res.error }, "delivery moved to dead letter");
    return { result: "dead" };
  }
  const delayMs = backoffMs(d.attempts);
  await finish("RETRY", { lastError: res.error, nextAttemptAt: new Date(Date.now() + delayMs) });
  logger.warn({ deliveryId: d.id, certificateId: row.cert.id, attempt: d.attempts, delayMs, error: res.error }, "whatsapp transient failure, will retry");
  return { result: "retry", delayMs };
}

/** Provider status callback (signature already verified by the route). */
export async function applyProviderStatus(clientRef: string, status: "delivered" | "read" | "failed", providerMessageId?: string) {
  if (!/^[0-9a-f-]{36}$/i.test(clientRef)) return false;
  if (status === "failed") {
    // Provider accepted but could not deliver (phone off etc.): allow another attempt.
    const r = await db.update(deliveries).set({ status: "RETRY", nextAttemptAt: new Date(), lastError: "provider reported delivery failure", updatedAt: new Date() })
      .where(and(eq(deliveries.id, clientRef), sql`${deliveries.status} in ('SENT')`)).returning({ id: deliveries.id });
    return r.length > 0;
  }
  const r = await db.update(deliveries).set({ status: "DELIVERED", updatedAt: new Date(), ...(providerMessageId ? { providerMessageId } : {}) })
    .where(and(eq(deliveries.id, clientRef), sql`${deliveries.status} in ('SENT','SENDING','RETRY')`)).returning({ certificateId: deliveries.certificateId });
  if (r[0]) {
    const [b] = await db.select({ id: batches.id, centreId: batches.centreId, districtId: batches.districtId }).from(certificates).innerJoin(batches, eq(batches.id, certificates.batchId)).where(eq(certificates.id, r[0].certificateId));
    if (b) await publish({ type: "delivery.updated", batchId: b.id, certificateId: r[0].certificateId, centreId: b.centreId, districtId: b.districtId, info: { status: "DELIVERED" } });
  }
  return r.length > 0;
}

/** State office: put a dead / permanently failed delivery back in the queue. */
export async function requeueDelivery(certificateId: string) {
  const r = await db.update(deliveries).set({ status: "RETRY", attempts: 0, nextAttemptAt: new Date(), lastError: "manually re-queued", updatedAt: new Date() })
    .where(and(eq(deliveries.certificateId, certificateId), sql`${deliveries.status} in ('DEAD','FAILED_PERMANENT')`)).returning({ id: deliveries.id });
  return r[0]?.id ?? null;
}

export { lt };
