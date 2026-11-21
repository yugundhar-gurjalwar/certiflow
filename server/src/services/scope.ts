import { and, eq, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { schema } from "../db/client.js";
import type { Actor } from "../auth/actor.js";

const { batches } = schema;

/**
 * Object-level access rule for batches. EVERY batch query goes through this, so an officer from another
 * district (or a centre looking at another centre's batch) gets "not found", never a leak.
 *  - centre:            only its own centre's batches
 *  - district officer:  only its district, and only once submitted (drafts are the centre's private work)
 *  - quality:           only batches that need quality review, once submitted
 *  - state:             everything that has been submitted
 */
export function batchScope(actor: Actor): SQL {
  switch (actor.role) {
    case "centre":
      return eq(batches.centreId, actor.centreId ?? "00000000-0000-0000-0000-000000000000");
    case "district_officer":
      return and(eq(batches.districtId, actor.districtId ?? "00000000-0000-0000-0000-000000000000"), ne(batches.status, "DRAFT"))!;
    case "quality":
      return and(eq(batches.requiresQuality, true), ne(batches.status, "DRAFT"))!;
    case "state":
      return ne(batches.status, "DRAFT");
    default:
      return sql`false`;
  }
}

export { and, eq, inArray, or };
