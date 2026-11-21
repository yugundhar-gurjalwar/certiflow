import { and, eq, inArray } from "drizzle-orm";
import { schema, type Executor } from "../db/client.js";
import { publish } from "./realtime.js";

const { users, notifications } = schema;

type Audience = { role: "centre"; centreId: string } | { role: "district_officer"; districtId: string } | { role: "quality" } | { role: "state" };

export async function usersIn(tx: Executor, a: Audience): Promise<string[]> {
  const where =
    a.role === "centre" ? and(eq(users.role, "centre"), eq(users.centreId, a.centreId), eq(users.active, true))
    : a.role === "district_officer" ? and(eq(users.role, "district_officer"), eq(users.districtId, a.districtId), eq(users.active, true))
    : and(eq(users.role, a.role), eq(users.active, true));
  const rows = await tx.select({ id: users.id }).from(users).where(where);
  return rows.map((r) => r.id);
}

/** In-app notification rows (written inside the caller's transaction). */
export async function notify(tx: Executor, userIds: string[], batchId: string | null, kind: string, message: string) {
  if (userIds.length === 0) return;
  await tx.insert(notifications).values(userIds.map((userId) => ({ userId, batchId, kind, message })));
}

/** After commit: tell connected browsers a notification exists (they refetch). */
export async function pingUsers(userIds: string[], batchId: string | null) {
  await Promise.all(userIds.map((userId) => publish({ type: "notification", userId, batchId: batchId ?? undefined })));
}

export { inArray };
