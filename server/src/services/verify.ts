import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { config } from "../config.js";
import { hasValidCheckCode } from "../domain/certNumber.js";
import { redis } from "../redis.js";
import { revokedKey, verifyKey } from "./certificates.js";

const { certificates, candidates, batches, centres, courses } = schema;

export type VerifyResult =
  | { valid: true; status: "VALID"; number: string; holderName: string; course: string; centre: string; issuedOn: string }
  | { valid: false; status: "CANCELLED"; number: string; message: string }
  | { valid: false; status: "NOT_FOUND"; message: string };

const NOT_FOUND: VerifyResult = { valid: false, status: "NOT_FOUND", message: "No certificate with this number was issued by Pragati Skills Mission." };

/**
 * Public, unauthenticated verification (moment 4). What it reveals: holder name, course, centre, issue date.
 * What it NEVER reveals: phone, email, score, batch, cancel reason.
 * Order of checks: (1) check-code (no DB for typos / scans) (2) revoked tombstone (3) cache (4) database.
 */
export async function verifyCertificate(raw: string): Promise<VerifyResult> {
  const number = raw.trim().toUpperCase();
  if (number.length > 40 || !hasValidCheckCode(number)) return NOT_FOUND;

  let cached: (string | null)[] = [null, null];
  try { cached = await redis.mget(revokedKey(number), verifyKey(number)); } catch { /* cache down: go to DB */ }
  if (cached[0]) return cancelled(number);
  if (cached[1]) return JSON.parse(cached[1]) as VerifyResult;

  const [row] = await db
    .select({ c: certificates, name: candidates.fullName, centre: centres.name, course: courses.name })
    .from(certificates)
    .innerJoin(candidates, eq(candidates.id, certificates.candidateId))
    .innerJoin(batches, eq(batches.id, certificates.batchId))
    .innerJoin(centres, eq(centres.id, batches.centreId))
    .innerJoin(courses, eq(courses.code, batches.courseCode))
    .where(eq(certificates.number, number));
  if (!row || row.c.status === "PENDING") return NOT_FOUND;
  if (row.c.status === "CANCELLED") return cancelled(number);

  const result: VerifyResult = {
    valid: true, status: "VALID", number, holderName: row.name, course: row.course, centre: row.centre,
    issuedOn: (row.c.issuedAt ?? row.c.createdAt).toISOString().slice(0, 10),
  };
  try {
    await redis.set(verifyKey(number), JSON.stringify(result), "EX", config.VERIFY_CACHE_TTL_S);
    // Close the race with a concurrent cancel: if a tombstone appeared meanwhile, drop what we just cached.
    if (await redis.exists(revokedKey(number))) { await redis.del(verifyKey(number)); return cancelled(number); }
  } catch { /* ignore */ }
  return result;
}

const cancelled = (number: string): VerifyResult => ({ valid: false, status: "CANCELLED", number, message: "This certificate has been CANCELLED and is no longer valid." });
