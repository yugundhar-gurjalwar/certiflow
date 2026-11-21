import { randomBytes } from "node:crypto";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db, schema, type Tx } from "../db/client.js";
import type { Actor } from "../auth/actor.js";
import { config } from "../config.js";
import { makeCertificateNumber } from "../domain/certNumber.js";
import { AppError, conflict, forbidden, notFound } from "../http/errors.js";
import { logger } from "../logger.js";
import { redis } from "../redis.js";
import { audit } from "./audit.js";
import { emit } from "./outbox.js";
import { publish } from "./realtime.js";
import { batchScope } from "./scope.js";
import { SYSTEM_ACTOR } from "../auth/actor.js";
import { renderCertificatePdf } from "./pdf.js";
import { storage } from "./storage.js";

const { certificates, candidates, batches, centres, courses, deliveries } = schema;

/**
 * Called INSIDE the final-approval transaction. Creates one PENDING certificate per candidate.
 * Idempotent three ways: the batch row is locked (one approval wins), certificates.candidate_id is UNIQUE,
 * and ON CONFLICT DO NOTHING makes a replay a no-op. Numbers come from a DB sequence -> unique by construction.
 */
export async function createCertificatesForBatch(tx: Tx, batchId: string): Promise<number> {
  const cands = await tx.select().from(candidates).where(eq(candidates.batchId, batchId));
  if (cands.length === 0) return 0;
  const seqRows = await tx.execute<{ n: string }>(sql`select nextval('certificate_number_seq')::text as n from generate_series(1, ${cands.length})`);
  const year = new Date().getUTCFullYear();
  let created = 0;
  for (let i = 0; i < cands.length; i += 500) {
    const chunk = cands.slice(i, i + 500);
    const values = chunk.map((c, j) => ({
      candidateId: c.id, batchId, courseCode: c.courseCode, phone: c.phone,
      number: makeCertificateNumber(seqRows.rows[i + j]!.n, year),
      downloadToken: randomBytes(24).toString("base64url"),
    }));
    const r = await tx.insert(certificates).values(values).onConflictDoNothing({ target: certificates.candidateId }).returning({ id: certificates.id });
    created += r.length;
  }
  return created;
}

/** Worker step 1: render the PDF, store it, mark ISSUED and create the (single) delivery row. Safe to run twice. */
export async function generateCertificate(certificateId: string, requestId?: string): Promise<"issued" | "skipped"> {
  const [row] = await db
    .select({ cert: certificates, cand: candidates, batch: batches, centreName: centres.name, courseName: courses.name })
    .from(certificates)
    .innerJoin(candidates, eq(candidates.id, certificates.candidateId))
    .innerJoin(batches, eq(batches.id, certificates.batchId))
    .innerJoin(centres, eq(centres.id, batches.centreId))
    .innerJoin(courses, eq(courses.code, batches.courseCode))
    .where(eq(certificates.id, certificateId));
  if (!row) return "skipped";
  if (row.cert.status === "CANCELLED") return "skipped";
  if (row.cert.status === "ISSUED") {
    await db.insert(deliveries).values({ certificateId }).onConflictDoNothing({ target: deliveries.certificateId });
    return "skipped";
  }

  const key = `${row.cert.number}.pdf`;
  const pdf = await renderCertificatePdf({
    number: row.cert.number, candidateName: row.cand.fullName, courseName: row.courseName, centreName: row.centreName,
    score: row.cand.score, issuedOn: new Date(),
  });
  await storage.put(key, pdf); // deterministic key + atomic rename: re-running overwrites the same file

  const issued = await db.transaction(async (tx) => {
    const upd = await tx.update(certificates)
      .set({ status: "ISSUED", issuedAt: new Date(), fileKey: key })
      .where(and(eq(certificates.id, certificateId), eq(certificates.status, "PENDING")))
      .returning({ id: certificates.id });
    if (upd.length === 0) return false; // cancelled (or already issued) meanwhile
    await tx.insert(deliveries).values({ certificateId }).onConflictDoNothing({ target: deliveries.certificateId });
    await audit(tx, SYSTEM_ACTOR("worker"), "certificate.issued", { batchId: row.batch.id, certificateId, details: { number: row.cert.number }, requestId });
    await emit(tx, "certificate.issued", certificateId, { batchId: row.batch.id }, requestId);
    return true;
  });
  if (issued) {
    logger.info({ certificateId, batchId: row.batch.id, number: row.cert.number }, "certificate issued");
    await publish({ type: "certificate.issued", batchId: row.batch.id, certificateId, centreId: row.batch.centreId, districtId: row.batch.districtId });
  }
  return issued ? "issued" : "skipped";
}

export const verifyKey = (number: string) => `cf:verify:${number}`;
export const revokedKey = (number: string) => `cf:revoked:${number}`;

/**
 * State office cancels a certificate (moment 4). The DB row is the truth; the cache is cleared and a long-lived
 * "revoked" tombstone is written so a verify request racing with the cancel can never re-cache "valid".
 */
export async function cancelCertificate(actor: Actor, certificateId: string, reason: string, requestId?: string) {
  if (actor.role !== "state") throw forbidden("Only the state office cancels certificates");
  const out = await db.transaction(async (tx) => {
    const [c] = await tx.select().from(certificates).where(eq(certificates.id, certificateId)).for("update");
    if (!c) throw notFound("Certificate");
    if (c.status === "CANCELLED") return { number: c.number, batchId: c.batchId, alreadyCancelled: true };
    await tx.update(certificates).set({ status: "CANCELLED", cancelledAt: new Date(), cancelledBy: actor.id, cancelReason: reason }).where(eq(certificates.id, c.id));
    // Stop any message that has not gone out yet.
    await tx.update(deliveries).set({ status: "SKIPPED", updatedAt: new Date(), lastError: "certificate cancelled" })
      .where(and(eq(deliveries.certificateId, c.id), sql`${deliveries.status} in ('QUEUED','RETRY')`));
    await audit(tx, actor, "certificate.cancelled", { batchId: c.batchId, certificateId: c.id, details: { number: c.number, reason, previousStatus: c.status }, requestId });
    await emit(tx, "certificate.cancelled", c.id, { number: c.number }, requestId);
    return { number: c.number, batchId: c.batchId, alreadyCancelled: false };
  });
  // Immediately after commit (the relay repeats this idempotently if we crash right here).
  await invalidateVerifyCache(out.number, true);
  await publish({ type: "certificate.cancelled", certificateId, batchId: out.batchId });
  return out;
}

export async function invalidateVerifyCache(number: string, revoked: boolean) {
  try {
    const m = redis.multi().del(verifyKey(number));
    if (revoked) m.set(revokedKey(number), "1", "EX", 60 * 60 * 24 * 30);
    await m.exec();
  } catch (e) {
    logger.warn({ err: String(e), number }, "verify cache invalidation failed (DB remains the source of truth)");
  }
}

/** State office search / listing of certificates (no personal contact data beyond what staff need). */
export async function searchCertificates(actor: Actor, q: string | undefined, limit = 50) {
  if (actor.role !== "state" && actor.role !== "quality" && actor.role !== "district_officer" && actor.role !== "centre") throw forbidden();
  const needle = q?.trim();
  const rows = await db
    .select({
      id: certificates.id, number: certificates.number, status: certificates.status, issuedAt: certificates.issuedAt,
      cancelReason: certificates.cancelReason, batchId: batches.id, batchName: batches.name,
      candidateName: candidates.fullName, courseCode: certificates.courseCode,
      deliveryStatus: deliveries.status, deliveryAttempts: deliveries.attempts,
    })
    .from(certificates)
    .innerJoin(candidates, eq(candidates.id, certificates.candidateId))
    .innerJoin(batches, eq(batches.id, certificates.batchId))
    .leftJoin(deliveries, eq(deliveries.certificateId, certificates.id))
    .where(and(batchScope(actor), needle ? or(ilike(certificates.number, `%${needle}%`), ilike(candidates.fullName, `%${needle}%`)) : undefined))
    .orderBy(desc(certificates.createdAt))
    .limit(Math.min(limit, 200));
  return rows;
}

export async function listBatchCertificates(actor: Actor, batchId: string) {
  const [b] = await db.select({ id: batches.id }).from(batches).where(and(eq(batches.id, batchId), batchScope(actor)));
  if (!b) throw notFound("Batch");
  return db
    .select({
      id: certificates.id, number: certificates.number, status: certificates.status, issuedAt: certificates.issuedAt,
      candidateName: candidates.fullName, deliveryStatus: deliveries.status, deliveryAttempts: deliveries.attempts, lastError: deliveries.lastError,
    })
    .from(certificates)
    .innerJoin(candidates, eq(candidates.id, certificates.candidateId))
    .leftJoin(deliveries, eq(deliveries.certificateId, certificates.id))
    .where(eq(certificates.batchId, batchId))
    .orderBy(candidates.fullName);
}

/** Staff download: the same scope rule as batches. Returns null body for non-ISSUED certificates. */
export async function staffCertificateFile(actor: Actor, certificateId: string) {
  const [row] = await db
    .select({ cert: certificates })
    .from(certificates)
    .innerJoin(batches, eq(batches.id, certificates.batchId))
    .where(and(eq(certificates.id, certificateId), batchScope(actor)));
  if (!row) throw notFound("Certificate");
  return fileOrThrow(row.cert);
}

/** Candidate download via the unguessable token that was sent to their own phone. */
export async function candidateCertificateFile(token: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw notFound("Certificate");
  const [c] = await db.select().from(certificates).where(eq(certificates.downloadToken, token));
  if (!c) throw notFound("Certificate");
  return fileOrThrow(c);
}

async function fileOrThrow(c: typeof certificates.$inferSelect) {
  if (c.status === "CANCELLED") throw new AppError(410, "CERTIFICATE_CANCELLED", "This certificate has been cancelled and is no longer valid");
  if (c.status !== "ISSUED" || !c.fileKey) throw new AppError(404, "NOT_READY", "Certificate is still being prepared");
  return { number: c.number, stream: await storage.get(c.fileKey) };
}

export { config, conflict };
