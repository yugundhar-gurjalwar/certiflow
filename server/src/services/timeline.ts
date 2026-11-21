import { and, asc, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import type { Actor } from "../auth/actor.js";
import { notFound } from "../http/errors.js";
import { batchScope } from "./scope.js";

const { auditLog, batches, certificates, deliveries, outbox, candidates } = schema;

/** "What happened to this batch?" end to end: who did what, when, plus the state of the background pipeline. */
export async function batchTimeline(actor: Actor, batchId: string) {
  const [b] = await db.select({ id: batches.id }).from(batches).where(and(eq(batches.id, batchId), batchScope(actor)));
  if (!b) throw notFound("Batch");
  const events = await db.select().from(auditLog).where(eq(auditLog.batchId, batchId)).orderBy(asc(auditLog.id)).limit(2000);
  const [pipe] = (await db.execute<{ unpublished: number }>(sql`select count(*)::int as unpublished from outbox where published_at is null and aggregate_id = ${batchId}`)).rows;
  return { events, outboxUnpublished: pipe?.unpublished ?? 0 };
}

export async function certificateTimeline(actor: Actor, certificateId: string) {
  const [row] = await db
    .select({ cert: certificates, name: candidates.fullName, delivery: deliveries })
    .from(certificates)
    .innerJoin(batches, eq(batches.id, certificates.batchId))
    .innerJoin(candidates, eq(candidates.id, certificates.candidateId))
    .leftJoin(deliveries, eq(deliveries.certificateId, certificates.id))
    .where(and(eq(certificates.id, certificateId), batchScope(actor)));
  if (!row) throw notFound("Certificate");
  const events = await db.select().from(auditLog).where(eq(auditLog.certificateId, certificateId)).orderBy(asc(auditLog.id));
  const { downloadToken: _omit, fileKey: _omit2, ...cert } = row.cert;
  return { certificate: cert, holderName: row.name, delivery: row.delivery, events };
}

export { outbox };
