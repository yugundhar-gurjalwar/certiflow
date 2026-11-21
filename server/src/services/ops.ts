import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { config } from "../config.js";
import { getQueue, QUEUE_NAMES } from "../jobs/queues.js";

/** State-office "what is stuck / what is unhealthy" view. */
export async function overview() {
  const stuck = await db.execute(sql`
    select b.id, b.name, b.status, b.round, b.candidate_count as "candidateCount", b.stage_entered_at as "stageEnteredAt",
           c.name as "centreName", d.name as "districtName",
           (select coalesce(max(e.level), 0) from escalations e where e.batch_id = b.id and e.round = b.round and e.stage = b.status) as "escalationLevel",
           extract(epoch from (now() - b.stage_entered_at))::int as "waitingSeconds"
    from batches b join centres c on c.id = b.centre_id join districts d on d.id = b.district_id
    where b.status in ('DISTRICT_REVIEW','QUALITY_REVIEW','STATE_REVIEW')
      and b.stage_entered_at <= now() - make_interval(mins => ${config.ESCALATION_LEVEL1_MINUTES})
    order by b.stage_entered_at asc limit 100`);
  const deliveries = await db.execute<{ status: string; n: number }>(sql`select status, count(*)::int as n from deliveries group by status`);
  const certs = await db.execute<{ status: string; n: number }>(sql`select status, count(*)::int as n from certificates group by status`);
  const batchesBy = await db.execute<{ status: string; n: number }>(sql`select status, count(*)::int as n from batches group by status`);
  const problem = await db.execute(sql`
    select d.certificate_id as "certificateId", c.number, d.status, d.attempts, d.last_error as "lastError", d.updated_at as "updatedAt"
    from deliveries d join certificates c on c.id = d.certificate_id
    where d.status in ('DEAD','FAILED_PERMANENT') order by d.updated_at desc limit 50`);
  let queues: Record<string, unknown> = {};
  try {
    for (const [k, name] of Object.entries(QUEUE_NAMES)) queues[k] = await getQueue(name).getJobCounts("waiting", "active", "delayed", "failed");
  } catch { queues = { error: "redis unavailable" }; }
  const toMap = (r: { rows: { status: string; n: number }[] }) => Object.fromEntries(r.rows.map((x) => [x.status, x.n]));
  return {
    thresholds: { level1Minutes: config.ESCALATION_LEVEL1_MINUTES, level2Minutes: config.ESCALATION_LEVEL2_MINUTES },
    stuckBatches: stuck.rows, deliveryProblems: problem.rows,
    deliveries: toMap(deliveries), certificates: toMap(certs), batches: toMap(batchesBy), queues,
  };
}
