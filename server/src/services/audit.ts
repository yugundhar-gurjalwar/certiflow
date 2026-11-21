import { schema, type Executor } from "../db/client.js";
import type { AuditActor } from "../auth/actor.js";

/** Writes one immutable audit row. Always called INSIDE the transaction that made the change, so a decision
 *  and its audit record commit together or not at all (never-happen #5: untraceable decisions). */
export async function audit(
  tx: Executor,
  actor: AuditActor,
  action: string,
  ctx: { batchId?: string | null; certificateId?: string | null; details?: Record<string, unknown>; requestId?: string | null },
) {
  await tx.insert(schema.auditLog).values({
    actorId: actor.id,
    actorName: actor.name,
    actorRole: actor.role,
    action,
    batchId: ctx.batchId ?? null,
    certificateId: ctx.certificateId ?? null,
    details: ctx.details ?? {},
    requestId: ctx.requestId ?? null,
  });
}
