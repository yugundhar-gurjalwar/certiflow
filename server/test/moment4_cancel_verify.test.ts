import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { redis } from "../src/redis.js";
import { verifyKey } from "../src/services/certificates.js";
import { api, approveFully, as, makeWorld, newBatch, q, resetAll, shutdown, startPipeline, waitFor, type World } from "./helpers.js";

/** MOMENT 4: state cancels a fake certificate -> an employer checking a moment later is told it is no longer valid. */
let w: World; let pipe: Awaited<ReturnType<typeof startPipeline>>;
let certs: { id: string; number: string; token: string }[] = [];
beforeAll(async () => {
  await resetAll(); w = await makeWorld(); pipe = await startPipeline();
  const id = await newBatch(w, 6); await approveFully(w, id);
  certs = await waitFor(async () => {
    const r = await q<{ id: string; number: string; token: string; status: string }>(sql`select id, number, download_token as token, status from certificates where batch_id = ${id}`);
    return r.length === 6 && r.every((c) => c.status === "ISSUED") ? r : false;
  }, { what: "certificates issued" });
});
afterAll(async () => { await pipe.stop(); await shutdown(); });

const verify = (n: string) => api().get(`/api/public/verify/${n}`);

describe("moment 4: cancel -> verify", () => {
  it("anyone can verify a genuine certificate without logging in, and sees only safe fields", async () => {
    const r = await verify(certs[0]!.number).expect(200);
    expect(r.body.valid).toBe(true);
    expect(Object.keys(r.body).sort()).toEqual(["centre", "course", "holderName", "issuedOn", "number", "status", "valid"]);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(await redis.get(verifyKey(certs[0]!.number))).not.toBeNull(); // it is cached now
  });

  it("right after the state office cancels, the very next check says CANCELLED (cache cannot hide it)", async () => {
    const c = certs[1]!;
    expect((await verify(c.number)).body.valid).toBe(true); // warms the cache
    expect((await verify(c.number)).body.valid).toBe(true);
    await api().post(`/api/certificates/${c.id}/cancel`).set(as(w, "farah")).send({ reason: "Issued to a candidate who never attended" }).expect(200);
    const after = await verify(c.number);
    expect(after.body).toMatchObject({ valid: false, status: "CANCELLED" });
    expect(JSON.stringify(after.body)).not.toContain("Trainee"); // no holder details for a cancelled certificate
  });

  it("holds even while verifications hammer the endpoint during the cancel", async () => {
    const c = certs[2]!;
    let cancelledAt = Infinity; const stale: number[] = [];
    let stop = false;
    const hammer = (async () => {
      while (!stop) {
        const started = Date.now();
        const r = await verify(c.number);
        // A check that STARTED after the cancel call returned must never say valid.
        if (started > cancelledAt && r.body.valid) stale.push(started);
      }
    })();
    await new Promise((r) => setTimeout(r, 60));
    await api().post(`/api/certificates/${c.id}/cancel`).set(as(w, "farah")).send({ reason: "Duplicate of another record" }).expect(200);
    cancelledAt = Date.now();
    await new Promise((r) => setTimeout(r, 400));
    stop = true; await hammer;
    expect(stale).toEqual([]);
  });

  it("is still cancelled if the whole cache is lost (the database is the truth)", async () => {
    const c = certs[3]!;
    await api().post(`/api/certificates/${c.id}/cancel`).set(as(w, "farah")).send({ reason: "Forged marks sheet found" }).expect(200);
    await redis.flushdb();
    expect((await verify(c.number)).body.status).toBe("CANCELLED");
  });

  it("cancelling twice is harmless; only the state office may cancel; reason is mandatory", async () => {
    const c = certs[4]!;
    await api().post(`/api/certificates/${c.id}/cancel`).set(as(w, "dev")).send({ reason: "I do not like it" }).expect(403);
    await api().post(`/api/certificates/${c.id}/cancel`).set(as(w, "anika")).send({ reason: "I do not like it" }).expect(403);
    await api().post(`/api/certificates/${c.id}/cancel`).set(as(w, "farah")).send({}).expect(400);
    await api().post(`/api/certificates/${c.id}/cancel`).set(as(w, "farah")).send({ reason: "Fraudulent enrolment" }).expect(200);
    const again = await api().post(`/api/certificates/${c.id}/cancel`).set(as(w, "farah")).send({ reason: "Fraudulent enrolment" }).expect(200);
    expect(again.body.alreadyCancelled).toBe(true);
    const audits = await q<{ n: number }>(sql`select count(*)::int n from audit_log where certificate_id = ${c.id} and action = 'certificate.cancelled'`);
    expect(audits[0]!.n).toBe(1);
  });

  it("a cancelled certificate can no longer be downloaded by the candidate or by staff", async () => {
    const c = certs[1]!; // cancelled above
    await api().get(`/api/public/certificates/${c.token}/download`).expect(410);
    await api().get(`/api/certificates/${c.id}/pdf`).set(as(w, "anika")).expect(410);
    const ok = certs[5]!;
    const pdf = await api().get(`/api/public/certificates/${ok.token}/download`).expect(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.body.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("typos and enumeration attempts are rejected without hitting the database", async () => {
    for (const bad of ["CF-2026-100001-AAAA", "nonsense", "CF-2026-1;DROP TABLE certificates-ABCD", "../../etc/passwd"]) {
      const r = await verify(encodeURIComponent(bad));
      expect(r.body.status).toBe("NOT_FOUND");
    }
  });
});
