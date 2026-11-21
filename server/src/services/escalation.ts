import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { SYSTEM_ACTOR } from "../auth/actor.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { REVIEW_STAGES, type Stage } from "../domain/workflow.js";
import { audit } from "./audit.js";
import { emit } from "./outbox.js";
import { notify, pingUsers, usersIn } from "./notifications.js";
import { publish } from "./realtime.js";

const { batches, escalations, approvals, users } = schema;

/**
 * Moment 5. Finds batches that have waited too long in a review stage and tells someone senior, exactly once per
 * (batch, round, stage, level) thanks to a UNIQUE index, so any number of schedulers can run this safely.
 *   level 1: reminder to the people who must act + heads-up to the state office
 *   level 2: urgent alert to the state office (everything older than the second threshold)
 * `now` is a parameter so tests can travel in time without sleeping.
 */
export async function runEscalations(now = new Date()): Promise<number> {
  const l1 = new Date(now.getTime() - config.ESCALATION_LEVEL1_MINUTES * 60_000);
  const overdue = await db.select().from(batches).where(and(inArray(batches.status, [...REVIEW_STAGES]), lte(batches.stageEnteredAt, l1)));
  let raised = 0;
  for (const b of overdue) {
    const ageMin = (now.getTime() - b.stageEnteredAt.getTime()) / 60_000;
    const levels = [1, ...(ageMin >= config.ESCALATION_LEVEL2_MINUTES ? [2] : [])];
    for (const level of levels) {
      const pingList: string[] = [];
      const done = await db.transaction(async (tx) => {
        const ins = await tx.insert(escalations).values({ batchId: b.id, round: b.round, stage: b.status, level }).onConflictDoNothing().returning({ id: escalations.id });
        if (ins.length === 0) return false;
        const stateUsers = await usersIn(tx, { role: "state" });
        const waitingOn = await peopleWaitedOn(tx, b, b.status as Stage);
        const hours = Math.floor(ageMin / 60);
        const msg = level === 1
          ? `Batch "${b.name}" has been waiting ${hours >= 1 ? `${hours}h` : `${Math.floor(ageMin)}m`} at ${b.status}`
          : `URGENT: batch "${b.name}" has been stuck ${hours >= 1 ? `${hours}h` : `${Math.floor(ageMin)}m`} at ${b.status}`;
        const targets = level === 1 ? [...new Set([...waitingOn, ...stateUsers])] : stateUsers;
        await notify(tx, targets, b.id, level === 1 ? "escalation" : "escalation_urgent", msg);
        pingList.push(...targets);
        await audit(tx, SYSTEM_ACTOR("scheduler"), "escalation.raised", { batchId: b.id, details: { level, stage: b.status, round: b.round, waitedMinutes: Math.round(ageMin), notified: targets.length } });
        await emit(tx, "escalation.raised", b.id, { level, stage: b.status });
        return true;
      });
      if (done) {
        raised++;
        logger.warn({ batchId: b.id, level, stage: b.status }, "batch escalated");
        await Promise.all([pingUsers(pingList, b.id), publish({ type: "escalation.raised", batchId: b.id, info: { level } })]);
      }
    }
  }
  return raised;
}

async function peopleWaitedOn(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], b: typeof batches.$inferSelect, stage: Stage): Promise<string[]> {
  if (stage === "DISTRICT_REVIEW") {
    // officers of the district who have not yet voted this round
    const rows = await tx.select({ id: users.id }).from(users).where(and(
      eq(users.role, "district_officer"), eq(users.districtId, b.districtId), eq(users.active, true),
      sql`not exists (select 1 from ${approvals} a where a.batch_id = ${b.id} and a.round = ${b.round} and a.stage = ${stage} and a.officer_id = ${users.id})`,
    ));
    return rows.map((r) => r.id);
  }
  return usersIn(tx, { role: stage === "QUALITY_REVIEW" ? "quality" : "state" });
}
