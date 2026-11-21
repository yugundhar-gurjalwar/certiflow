import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db, schema, type Executor, type Tx } from "../db/client.js";
import { pgError } from "../db/errors.js";
import type { Actor } from "../auth/actor.js";
import { AppError, conflict, forbidden, notFound } from "../http/errors.js";
import { EDITABLE_BY_CENTRE, requiresQualityReview } from "../domain/workflow.js";
import { normalisePhone, validateGrid, type RowError } from "../domain/csv.js";
import { audit } from "./audit.js";
import { emit } from "./outbox.js";
import { notify, pingUsers, usersIn } from "./notifications.js";
import { publish } from "./realtime.js";
import { batchScope } from "./scope.js";

const { batches, candidates, centres, courses, approvals, certificates } = schema;

export type BatchRow = typeof batches.$inferSelect;

/** Load a batch the actor is allowed to see (404 otherwise). With lock=true takes a row lock (FOR UPDATE). */
export async function loadBatch(tx: Executor, actor: Actor, id: string, lock = false): Promise<BatchRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Batch");
  const q = tx.select().from(batches).where(and(eq(batches.id, id), batchScope(actor))).limit(1);
  const [b] = lock ? await q.for("update") : await q;
  if (!b) throw notFound("Batch");
  return b;
}

export async function createBatch(actor: Actor, input: { name: string; courseCode: string }, requestId?: string) {
  if (actor.role !== "centre" || !actor.centreId) throw forbidden("Only training centres create batches");
  return db.transaction(async (tx) => {
    const [centre] = await tx.select().from(centres).where(eq(centres.id, actor.centreId!));
    const [course] = await tx.select().from(courses).where(eq(courses.code, input.courseCode));
    if (!centre) throw notFound("Centre");
    if (!course) throw new AppError(422, "UNKNOWN_COURSE", `Unknown course ${input.courseCode}`);
    const [b] = await tx.insert(batches).values({
      name: input.name, courseCode: course.code, centreId: centre.id, districtId: centre.districtId, createdBy: actor.id,
    }).returning();
    await audit(tx, actor, "batch.created", { batchId: b!.id, details: { name: input.name, course: course.code }, requestId });
    return b!;
  });
}

export async function listBatches(actor: Actor, filter: { status?: string[] } = {}) {
  const where = and(batchScope(actor), filter.status?.length ? inArray(batches.status, filter.status) : undefined);
  const rows = await db
    .select({
      batch: batches,
      centreName: centres.name,
      courseName: courses.name,
      // how many votes the CURRENT round has at the CURRENT stage, and whether this actor has voted
      approveVotes: sql<number>`(select count(*)::int from approvals a where a.batch_id = ${batches.id} and a.round = ${batches.round} and a.stage = ${batches.status} and a.decision = 'approve')`,
      rejectVotes: sql<number>`(select count(*)::int from approvals a where a.batch_id = ${batches.id} and a.round = ${batches.round} and a.stage = ${batches.status} and a.decision = 'reject')`,
      iVoted: sql<boolean>`exists (select 1 from approvals a where a.batch_id = ${batches.id} and a.round = ${batches.round} and a.stage = ${batches.status} and a.officer_id = ${actor.id})`,
    })
    .from(batches)
    .innerJoin(centres, eq(centres.id, batches.centreId))
    .innerJoin(courses, eq(courses.code, batches.courseCode))
    .where(where)
    .orderBy(asc(batches.stageEnteredAt)) // oldest-waiting first: the files that "sit for days" float to the top
    .limit(500);
  return rows.map((r) => ({ ...r.batch, centreName: r.centreName, courseName: r.courseName, approveVotes: r.approveVotes, rejectVotes: r.rejectVotes, iVoted: r.iVoted }));
}

export async function getBatchDetail(actor: Actor, id: string) {
  const batch = await loadBatch(db, actor, id);
  const [centre] = await db.select().from(centres).where(eq(centres.id, batch.centreId));
  const [course] = await db.select().from(courses).where(eq(courses.code, batch.courseCode));
  const cands = await db.select({
    id: candidates.id, enrolmentNo: candidates.enrolmentNo, fullName: candidates.fullName, phone: candidates.phone,
    email: candidates.email, score: candidates.score,
  }).from(candidates).where(eq(candidates.batchId, id)).orderBy(asc(candidates.enrolmentNo));
  const votes = await db
    .select({ stage: approvals.stage, round: approvals.round, decision: approvals.decision, reason: approvals.reason, at: approvals.createdAt, officerName: schema.users.name, officerId: approvals.officerId })
    .from(approvals).innerJoin(schema.users, eq(schema.users.id, approvals.officerId))
    .where(eq(approvals.batchId, id)).orderBy(asc(approvals.createdAt));
  const certStats = await db.select({ status: certificates.status, n: sql<number>`count(*)::int` }).from(certificates).where(eq(certificates.batchId, id)).groupBy(certificates.status);
  const delivStats = await db.execute<{ status: string; n: number }>(
    sql`select d.status, count(*)::int as n from deliveries d join certificates c on c.id = d.certificate_id where c.batch_id = ${id} group by d.status`,
  );
  return {
    ...batch, centreName: centre?.name, courseName: course?.name, passScore: course?.passScore,
    candidates: cands, votes,
    certificates: Object.fromEntries(certStats.map((s) => [s.status, s.n])),
    deliveries: Object.fromEntries(delivStats.rows.map((s) => [s.status, s.n])),
  };
}

export class ImportRejected extends AppError {
  constructor(public readonly errors: RowError[], total: number) {
    super(422, "IMPORT_REJECTED", `Nothing was saved: ${total} problem(s) found in the file`, { errors, total });
  }
}

/**
 * All-or-nothing import (moment 1). The file is validated completely in memory first; the database is only
 * touched if there are zero errors, and then everything is written in ONE transaction. The spreadsheet is the
 * source of truth: importing replaces the draft's candidate list.
 */
export async function importCandidates(actor: Actor, batchId: string, grid: string[][], requestId?: string) {
  if (actor.role !== "centre") throw forbidden("Only training centres import candidates");
  return db.transaction(async (tx) => {
    const batch = await loadBatch(tx, actor, batchId, true);
    if (!(EDITABLE_BY_CENTRE as readonly string[]).includes(batch.status))
      throw conflict("NOT_EDITABLE", `Batch is ${batch.status}; candidates can only be changed in DRAFT or CHANGES_REQUESTED`);
    const [course] = await tx.select().from(courses).where(eq(courses.code, batch.courseCode));
    const { rows, errors } = validateGrid(grid, course!.passScore);

    // Cross-batch rule: a person may hold only one certificate per course (also enforced by a DB index at issue time).
    if (rows.length) {
      const phones = rows.map((r) => r.phone);
      const clashes = await tx
        .select({ phone: candidates.phone, batchName: batches.name, status: batches.status })
        .from(candidates)
        .innerJoin(batches, eq(batches.id, candidates.batchId))
        .where(and(
          eq(candidates.courseCode, batch.courseCode),
          ne(candidates.batchId, batch.id),
          inArray(candidates.phone, phones),
          inArray(batches.status, ["DISTRICT_REVIEW", "QUALITY_REVIEW", "STATE_REVIEW", "APPROVED"]),
        ));
      const byPhone = new Map(clashes.map((c) => [c.phone, c]));
      for (const r of rows) {
        const c = byPhone.get(r.phone);
        if (c) errors.push({ row: r.row, column: "phone", code: "ALREADY_IN_ANOTHER_BATCH", message: `Phone ${r.phone} is already in batch "${c.batchName}" (${c.status}) for this course` });
      }
    }
    if (errors.length) throw new ImportRejected(errors.sort((a, b) => a.row - b.row), errors.length);

    await tx.delete(candidates).where(eq(candidates.batchId, batch.id));
    for (let i = 0; i < rows.length; i += 500) {
      await tx.insert(candidates).values(rows.slice(i, i + 500).map((r) => ({
        batchId: batch.id, enrolmentNo: r.enrolmentNo, fullName: r.fullName, phone: r.phone, email: r.email, score: r.score, courseCode: batch.courseCode,
      })));
    }
    await tx.update(batches).set({ candidateCount: rows.length, requiresQuality: requiresQualityReview(rows.length), updatedAt: new Date() }).where(eq(batches.id, batch.id));
    await audit(tx, actor, "batch.candidates_imported", { batchId: batch.id, details: { count: rows.length }, requestId });
    return { imported: rows.length, requiresQualityReview: requiresQualityReview(rows.length) };
  }).then(async (r) => {
    await publish({ type: "batch.updated", batchId, centreId: actor.centreId });
    return r;
  });
}

/** Centre sends the batch for approval (or resends it after fixing a send-back). */
export async function submitBatch(actor: Actor, batchId: string, requestId?: string) {
  if (actor.role !== "centre") throw forbidden("Only training centres submit batches");
  const out = await db.transaction(async (tx) => {
    const b = await loadBatch(tx, actor, batchId, true);
    if (!(EDITABLE_BY_CENTRE as readonly string[]).includes(b.status)) throw conflict("INVALID_STATE", `Batch is ${b.status} and cannot be submitted`);
    if (b.candidateCount === 0) throw new AppError(422, "EMPTY_BATCH", "Add candidates before sending for approval");
    const resubmission = b.status === "CHANGES_REQUESTED";
    const [{ voided }] = (await tx.execute<{ voided: number }>(sql`select count(*)::int as voided from approvals where batch_id = ${b.id} and round = ${b.round}`)).rows as [{ voided: number }];
    // D-6: a resubmission starts a NEW round. Earlier approvals stay in history but no longer count.
    const round = resubmission ? b.round + 1 : b.round;
    await tx.update(batches).set({ status: "DISTRICT_REVIEW", round, stageEnteredAt: new Date(), updatedAt: new Date(), lastReason: null, requiresQuality: requiresQualityReview(b.candidateCount) }).where(eq(batches.id, b.id));
    await audit(tx, actor, resubmission ? "batch.resubmitted" : "batch.submitted", { batchId: b.id, details: { round, candidates: b.candidateCount, requiresQuality: requiresQualityReview(b.candidateCount), earlierApprovalsVoided: resubmission ? voided : 0 }, requestId });
    await emit(tx, "batch.submitted", b.id, { round }, requestId);
    const officers = await usersIn(tx, { role: "district_officer", districtId: b.districtId });
    await notify(tx, officers, b.id, "review_requested", `"${b.name}" (${b.candidateCount} candidates) is waiting for district review${resubmission ? " (resubmitted)" : ""}`);
    return { officers, districtId: b.districtId, centreId: b.centreId, round };
  });
  await Promise.all([publish({ type: "batch.submitted", batchId, centreId: out.centreId, districtId: out.districtId }), pingUsers(out.officers, batchId)]);
  return { status: "DISTRICT_REVIEW", round: out.round };
}

/** District officer corrects a typo during review. D-6b: any content change voids votes already cast this round. */
export async function correctCandidate(actor: Actor, batchId: string, candidateId: string, patch: { fullName?: string; phone?: string; email?: string | null }, requestId?: string) {
  if (actor.role !== "district_officer") throw forbidden("Only district officers correct candidate details during review");
  const res = await db.transaction(async (tx) => {
    const b = await loadBatch(tx, actor, batchId, true);
    if (b.status !== "DISTRICT_REVIEW") throw conflict("INVALID_STATE", "Corrections are only possible while the batch is in district review");
    const [c] = await tx.select().from(candidates).where(and(eq(candidates.id, candidateId), eq(candidates.batchId, b.id)));
    if (!c) throw notFound("Candidate");
    const next = { ...patch };
    if (next.phone !== undefined) {
      const p = normalisePhone(next.phone);
      if (!p) throw new AppError(422, "INVALID_PHONE", "Not a valid Indian mobile number");
      next.phone = p;
    }
    if (next.fullName !== undefined) next.fullName = next.fullName.replace(/\s+/g, " ").trim();
    try {
      await tx.update(candidates).set(next).where(eq(candidates.id, c.id));
    } catch (e) {
      if (pgError(e).code === "23505") throw conflict("DUPLICATE", "Another candidate in this batch already has that phone number");
      throw e;
    }
    const [{ voided }] = (await tx.execute<{ voided: number }>(sql`select count(*)::int as voided from approvals where batch_id = ${b.id} and round = ${b.round}`)).rows as [{ voided: number }];
    await tx.update(batches).set({ round: b.round + 1, updatedAt: new Date() }).where(eq(batches.id, b.id));
    await audit(tx, actor, "batch.candidate_corrected", { batchId: b.id, details: { candidateId: c.id, enrolmentNo: c.enrolmentNo, before: { fullName: c.fullName, phone: c.phone, email: c.email }, after: next, votesVoided: voided, newRound: b.round + 1 }, requestId });
    await emit(tx, "batch.edited", b.id, { round: b.round + 1 }, requestId);
    return { districtId: b.districtId, centreId: b.centreId, newRound: b.round + 1, votesVoided: voided };
  });
  await publish({ type: "batch.updated", batchId, districtId: res.districtId, centreId: res.centreId });
  return res;
}

export async function deleteDraftBatch(actor: Actor, batchId: string, requestId?: string) {
  if (actor.role !== "centre") throw forbidden("Only training centres delete drafts");
  await db.transaction(async (tx) => {
    const b = await loadBatch(tx, actor, batchId, true);
    if (b.status !== "DRAFT") throw conflict("INVALID_STATE", "Only drafts can be deleted");
    await audit(tx, actor, "batch.draft_deleted", { batchId: null, details: { batchId: b.id, name: b.name }, requestId });
    await tx.delete(batches).where(eq(batches.id, b.id));
  });
}

export { desc, ne };
export type { Tx };
