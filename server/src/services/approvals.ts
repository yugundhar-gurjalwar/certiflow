import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { pgError } from "../db/errors.js";
import type { Actor } from "../auth/actor.js";
import { AppError, conflict, forbidden } from "../http/errors.js";
import { isStage, nextStatusOnApproval, outcomeOf, STAGE_RANK, STAGE_RANK_BY_ROLE, STAGE_ROLE, type Stage } from "../domain/workflow.js";
import { audit } from "./audit.js";
import { loadBatch } from "./batches.js";
import { createCertificatesForBatch } from "./certificates.js";
import { emit } from "./outbox.js";
import { notify, pingUsers, usersIn } from "./notifications.js";
import { publish } from "./realtime.js";

const { batches, approvals } = schema;

export type Decision = "approve" | "reject" | "send_back";

/**
 * THE decision endpoint for every review stage. Correctness rests on four things (docs/DECISIONS.md D-3):
 *  1. `SELECT ... FOR UPDATE` on the batch row serialises everything that touches one batch.
 *  2. The step is re-checked AFTER the lock: the batch must be in a stage owned by the caller's role.
 *  3. UNIQUE(batch, round, stage, officer) makes a second vote by the same person impossible.
 *  4. Counting + advancing happen in the same transaction as the vote, so "two officers approve at the same
 *     moment" results in exactly one transition: the second transaction waits for the lock, then sees the
 *     first one's vote, reaches quorum itself, and the third arrival finds the batch already moved on (409).
 */
export async function decide(actor: Actor, batchId: string, input: { decision: Decision; reason?: string }, requestId?: string) {
  const result = await db.transaction(async (tx) => {
    const batch = await loadBatch(tx, actor, batchId, true);
    if (!isStage(batch.status)) throw conflict("INVALID_STATE", `Batch is ${batch.status}; it is not waiting for a decision`);
    const stage: Stage = batch.status;
    if (STAGE_ROLE[stage] !== actor.role) {
      // Late arrival of a legitimate decider: their step is already behind the batch (e.g. the third officer
      // of a race that two colleagues already won). That is a conflict, not a permissions problem.
      if (STAGE_RANK[stage] > (STAGE_RANK_BY_ROLE[actor.role] ?? 99)) throw conflict("ALREADY_ADVANCED", "This batch has already moved past your review step");
      throw forbidden(`This step (${stage}) belongs to the ${STAGE_ROLE[stage].replace("_", " ")} role`);
    }
    if ((input.decision === "reject" || input.decision === "send_back") && (input.reason?.trim().length ?? 0) < 5)
      throw new AppError(422, "REASON_REQUIRED", "A reason of at least 5 characters is required");

    const base = { batchId: batch.id, requestId };

    if (input.decision === "send_back") {
      // Reversible and cautious -> one officer is enough. Votes of this round stay in history.
      await tx.update(batches).set({ status: "CHANGES_REQUESTED", lastReason: input.reason!.trim(), stageEnteredAt: new Date(), updatedAt: new Date() }).where(eq(batches.id, batch.id));
      await audit(tx, actor, "batch.sent_back", { ...base, details: { stage, round: batch.round, reason: input.reason!.trim() } });
      await emit(tx, "batch.sent_back", batch.id, { stage, round: batch.round }, requestId);
      const centreUsers = await usersIn(tx, { role: "centre", centreId: batch.centreId });
      await notify(tx, centreUsers, batch.id, "sent_back", `"${batch.name}" was sent back by ${actor.name}: ${input.reason!.trim()}`);
      return { batch, outcome: "sent_back" as const, status: "CHANGES_REQUESTED", notifyUsers: centreUsers, advanced: true, approveVotes: 0, rejectVotes: 0 };
    }

    // Record the vote. A repeated vote by the same officer in the same round/stage violates the unique index.
    const inserted = await tx.insert(approvals).values({
      batchId: batch.id, round: batch.round, stage, officerId: actor.id, decision: input.decision, reason: input.reason?.trim() ?? null,
    }).onConflictDoNothing().returning({ id: approvals.id });
    if (inserted.length === 0) throw conflict("ALREADY_VOTED", "You have already recorded a decision on this batch in this review round");
    await audit(tx, actor, input.decision === "approve" ? "batch.vote_approve" : "batch.vote_reject", { ...base, details: { stage, round: batch.round, reason: input.reason?.trim() ?? null } });

    const tallyRows = await tx.select({ decision: approvals.decision, n: sql<number>`count(*)::int` }).from(approvals)
      .where(and(eq(approvals.batchId, batch.id), eq(approvals.round, batch.round), eq(approvals.stage, stage))).groupBy(approvals.decision);
    const tally = { approve: tallyRows.find((r) => r.decision === "approve")?.n ?? 0, reject: tallyRows.find((r) => r.decision === "reject")?.n ?? 0 };
    const outcome = outcomeOf(stage, tally);

    if (outcome === "pending") {
      await emit(tx, "batch.advanced", batch.id, { stage, pending: true, ...tally }, requestId);
      return { batch, outcome, status: batch.status, notifyUsers: [] as string[], advanced: false, approveVotes: tally.approve, rejectVotes: tally.reject };
    }

    if (outcome === "reject") {
      await tx.update(batches).set({ status: "REJECTED", lastReason: input.reason?.trim() ?? "Rejected", stageEnteredAt: new Date(), updatedAt: new Date() }).where(eq(batches.id, batch.id));
      await audit(tx, actor, "batch.rejected", { ...base, details: { stage, round: batch.round, votes: tally } });
      await emit(tx, "batch.rejected", batch.id, { stage }, requestId);
      const centreUsers = await usersIn(tx, { role: "centre", centreId: batch.centreId });
      await notify(tx, centreUsers, batch.id, "rejected", `"${batch.name}" was rejected at ${stage}`);
      return { batch, outcome, status: "REJECTED", notifyUsers: centreUsers, advanced: true, approveVotes: tally.approve, rejectVotes: tally.reject };
    }

    // outcome === "advance": the quorum is reached, exactly once, because we hold the row lock.
    const next = nextStatusOnApproval(stage, batch.requiresQuality);
    await tx.update(batches).set({ status: next, stageEnteredAt: new Date(), updatedAt: new Date() }).where(eq(batches.id, batch.id));
    await audit(tx, actor, "batch.advanced", { ...base, details: { from: stage, to: next, round: batch.round, votes: tally } });
    let notifyUsers: string[] = [];
    if (next === "APPROVED") {
      const created = await createCertificatesForBatch(tx, batch.id);
      await audit(tx, actor, "batch.certificates_created", { ...base, details: { count: created } });
      await emit(tx, "batch.approved", batch.id, { certificates: created }, requestId);
      notifyUsers = await usersIn(tx, { role: "centre", centreId: batch.centreId });
      await notify(tx, notifyUsers, batch.id, "approved", `"${batch.name}" was approved: ${created} certificates are being issued`);
    } else {
      await emit(tx, "batch.advanced", batch.id, { from: stage, to: next }, requestId);
      notifyUsers = next === "QUALITY_REVIEW" ? await usersIn(tx, { role: "quality" }) : await usersIn(tx, { role: "state" });
      await notify(tx, notifyUsers, batch.id, "review_requested", `"${batch.name}" (${batch.candidateCount} candidates) is waiting for ${next === "QUALITY_REVIEW" ? "quality" : "state"} review`);
    }
    return { batch, outcome, status: next, notifyUsers, advanced: true, approveVotes: tally.approve, rejectVotes: tally.reject };
  }).catch((e) => {
    // A candidate who already holds an active certificate for this course (from another batch) trips the DB index.
    const pg = pgError(e);
    if (pg.code === "23505" && String(pg.constraint).includes("one_active_per_person"))
      throw conflict("DUPLICATE_CERTIFICATE", "A candidate in this batch already holds an active certificate for this course; approval was rolled back", { detail: pg.detail });
    throw e;
  });

  await Promise.all([
    publish({ type: "batch.changed", batchId, centreId: result.batch.centreId, districtId: result.batch.districtId, info: { status: result.status } }),
    pingUsers(result.notifyUsers, batchId),
  ]);
  return { status: result.status, outcome: result.outcome, advanced: result.advanced, approveVotes: result.approveVotes, rejectVotes: result.rejectVotes };
}
