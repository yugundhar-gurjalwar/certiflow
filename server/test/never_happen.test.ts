import jwt from "jsonwebtoken";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { db, schema } from "../src/db/client.js";
/** drizzle wraps pg errors; the trigger/constraint message lives on `.cause`. */
const dbRejects = async (p: Promise<unknown>, re: RegExp) => {
  const e = await p.then(() => null, (x: { message: string; cause?: { message: string } }) => x);
  expect(e, "statement should have been rejected by the database").not.toBeNull();
  expect(`${e!.cause?.message ?? ""} ${e!.message}`).toMatch(re);
};
import { api, approveFully, as, csvFor, decision, expectOk, makeWorld, newBatch, q, resetAll, shutdown, startPipeline, submit, waitFor, type World } from "./helpers.js";

/**
 * The five things that must NEVER happen. Each describe block is one rule from the problem statement.
 */
let w: World; let pipe: Awaited<ReturnType<typeof startPipeline>>;
beforeAll(async () => { await resetAll(); w = await makeWorld(); pipe = await startPipeline(); });
afterAll(async () => { await pipe.stop(); await shutdown(); });

describe("NEVER #1: acting at a step that isn't yours, or as someone else", () => {
  it("roles are tied to steps: nobody can decide at another role's step", async () => {
    const id = await newBatch(w, 3); await submit(w, id);
    expect((await decision(w, id, "anika", "approve")).status).toBe(403); // centre cannot approve its own batch
    expect((await decision(w, id, "neha", "approve")).status).toBe(404); // quality team cannot even see a small batch
    expect((await decision(w, id, "farah", "approve")).status).toBe(403); // state cannot skip district review
    expect((await decision(w, id, "sunita", "approve")).status).toBe(404); // other district's officer: not found, not "forbidden" (no leak)
    expect((await api().get(`/api/batches/${id}`).set(as(w, "sunita"))).status).toBe(404);
  });

  it("the actor always comes from the verified token, never from the request body", async () => {
    const id = await newBatch(w, 3); await submit(w, id);
    const r = await api().post(`/api/batches/${id}/decision`).set(as(w, "dev")).send({ decision: "approve", officerId: w.ids.meera, actor: "meera", role: "state" });
    expect(r.status).toBe(200);
    const votes = await q<{ officer_id: string }>(sql`select officer_id from approvals where batch_id = ${id}`);
    expect(votes.map((v) => v.officer_id)).toEqual([w.ids.dev]);
    // so a second "approval" smuggled in under Meera's name by Dev does not count as Meera's
    expect((await decision(w, id, "dev", "approve")).status).toBe(409);
  });

  it("forged, unsigned, expired or foreign tokens are refused", async () => {
    const id = await newBatch(w, 2);
    const forged = jwt.sign({ sub: w.ids.farah }, "attacker-secret-attacker-secret", { algorithm: "HS256" });
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: w.ids.farah })).toString("base64url")}.`;
    const expired = jwt.sign({ sub: w.ids.farah }, config.JWT_SECRET, { algorithm: "HS256", expiresIn: -10 });
    for (const t of [forged, none, expired, "garbage", ""]) {
      expect((await api().get(`/api/batches/${id}`).set("Authorization", `Bearer ${t}`)).status).toBe(401);
    }
    expect((await api().get("/api/batches")).status).toBe(401);
  });

  it("a deactivated account stops working immediately, even with a still-valid token", async () => {
    await db.update(schema.users).set({ active: false }).where(sql`id = ${w.ids.kabir}`);
    expect((await api().get("/api/batches").set(as(w, "kabir"))).status).toBe(401);
    await db.update(schema.users).set({ active: true }).where(sql`id = ${w.ids.kabir}`);
  });

  it("centres cannot touch each other's batches or submit someone else's", async () => {
    const id = await newBatch(w, 2);
    expect((await api().post(`/api/batches/${id}/submit`).set(as(w, "rohan"))).status).toBe(404);
    expect((await api().delete(`/api/batches/${id}`).set(as(w, "rohan"))).status).toBe(404);
    expect((await api().get("/api/batches").set(as(w, "rohan"))).body.map((b: { id: string }) => b.id)).not.toContain(id);
  });

  it("officers cannot create or import batches; centres cannot cancel certificates", async () => {
    await api().post("/api/batches").set(as(w, "dev")).send({ name: "x y z", courseCode: "WELD-101" }).expect(403);
    await api().post("/api/certificates/00000000-0000-0000-0000-000000000000/cancel").set(as(w, "anika")).send({ reason: "because I said" }).expect(403);
  });
});

describe("NEVER #2: two certificates for one candidate / two certificates sharing a number", () => {
  it("the database itself rejects duplicates (so even a bug in the app cannot create them)", async () => {
    const id = await newBatch(w, 2); await approveFully(w, id);
    const [c] = await q<{ id: string; candidate_id: string; number: string; batch_id: string; phone: string }>(sql`select * from certificates where batch_id = ${id} limit 1`);
    const other = (await q<{ number: string }>(sql`select number from certificates where batch_id = ${id} and id <> ${c!.id}`))[0]!;
    await dbRejects(db.execute(sql`insert into certificates (candidate_id, batch_id, number, course_code, phone, download_token) values (${c!.candidate_id}, ${id}, 'CF-2026-999999-AAAA', 'WELD-101', '+919999999999', 'tok-dup-candidate-1234567890')`), /unique|duplicate/i);
    await dbRejects(db.execute(sql`update certificates set number = ${other.number} where id = ${c!.id}`), /./);
  });

  it("re-running issuance for an approved batch creates nothing new", async () => {
    const id = await newBatch(w, 4); await approveFully(w, id);
    const { createCertificatesForBatch } = await import("../src/services/certificates.js");
    const again = await db.transaction((tx) => createCertificatesForBatch(tx, id));
    expect(again).toBe(0);
    expect((await q<{ n: number }>(sql`select count(*)::int n from certificates where batch_id = ${id}`))[0]!.n).toBe(4);
  });

  it("a person cannot hold two active certificates for a course even via two different batches (DB index backs the import check)", async () => {
    const shared = csvFor(2, { prefix: "DUP" });
    const a = await newBatch(w, 2, { csv: shared, name: "Original batch" });
    await approveFully(w, a);
    // Import check blocks it politely...
    const b = await newBatch(w, 1, { name: "Second batch" });
    const blocked = await api().post(`/api/batches/${b}/import`).set(as(w, "anika")).attach("file", Buffer.from(shared.replace(/DUP-/g, "ZZZ-")), "b.csv");
    expect(blocked.status).toBe(422);
    // ...and if someone bypasses the import check entirely (rows inserted straight into the DB), approval is still stopped.
    const phone = (await q<{ phone: string }>(sql`select phone from candidates where batch_id = ${a} limit 1`))[0]!.phone;
    await q(sql`delete from candidates where batch_id = ${b}`);
    await q(sql`insert into candidates (batch_id, enrolment_no, full_name, phone, score, course_code) values (${b}, 'SNEAK-1', 'Sneaky Duplicate', ${phone}, 80, 'WELD-101')`);
    await q(sql`update batches set candidate_count = 1 where id = ${b}`);
    await submit(w, b);
    expectOk(await decision(w, b, "dev", "approve")); expectOk(await decision(w, b, "meera", "approve"));
    const res = await decision(w, b, "farah", "approve");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("DUPLICATE_CERTIFICATE");
    // and it was rolled back completely: still awaiting the state office, no certificate, no 'approved' audit row
    expect((await api().get(`/api/batches/${b}`).set(as(w, "farah"))).body.status).toBe("STATE_REVIEW");
    expect((await q<{ n: number }>(sql`select count(*)::int n from certificates where batch_id = ${b}`))[0]!.n).toBe(0);
    expect((await q<{ n: number }>(sql`select count(*)::int n from audit_log where batch_id = ${b} and action = 'batch.advanced' and details->>'to' = 'APPROVED'`))[0]!.n).toBe(0);
  });

  it("certificate numbers across a big concurrent issuance are all distinct and carry a valid check code", async () => {
    const id = await newBatch(w, 60); await approveFully(w, id, true);
    const nums = await q<{ number: string }>(sql`select number from certificates where batch_id = ${id}`);
    expect(new Set(nums.map((n) => n.number)).size).toBe(60);
    const { hasValidCheckCode } = await import("../src/domain/certNumber.js");
    expect(nums.every((n) => hasValidCheckCode(n.number))).toBe(true);
    await waitFor(async () => (await q<{ n: number }>(sql`select count(*)::int n from deliveries d join certificates c on c.id = d.certificate_id where c.batch_id = ${id} and d.status in ('SENT','DELIVERED')`))[0]!.n === 60, { timeoutMs: 30_000 });
  });
});

describe("NEVER #3: a cancelled certificate showing as genuine", () => {
  it("the database refuses to reinstate a cancelled certificate, even to a superuser's UPDATE", async () => {
    const id = await newBatch(w, 1); await approveFully(w, id);
    const [c] = await waitFor(async () => { const r = await q<{ id: string; number: string }>(sql`select id, number from certificates where batch_id = ${id} and status = 'ISSUED'`); return r.length ? r : false; });
    await api().post(`/api/certificates/${c!.id}/cancel`).set(as(w, "farah")).send({ reason: "Cancelled for the test" }).expect(200);
    await dbRejects(db.execute(sql`update certificates set status = 'ISSUED' where id = ${c!.id}`), /cannot be reinstated/);
    await dbRejects(db.execute(sql`delete from certificates where id = ${c!.id}`), /cannot be deleted/);
    expect((await api().get(`/api/public/verify/${c!.number}`)).body.status).toBe("CANCELLED");
  });

  it("a cancel that is not yet delivered stops the WhatsApp message (nothing cancelled is sent afterwards)", async () => {
    pipe.sim.cfg.outage = true;
    const id = await newBatch(w, 2); await approveFully(w, id);
    const certs = await waitFor(async () => { const r = await q<{ id: string }>(sql`select id from certificates where batch_id = ${id} and status = 'ISSUED'`); return r.length === 2 ? r : false; });
    await api().post(`/api/certificates/${certs[0]!.id}/cancel`).set(as(w, "farah")).send({ reason: "Cancelled before delivery" }).expect(200);
    pipe.sim.cfg.outage = false;
    await waitFor(async () => (await q<{ n: number }>(sql`select count(*)::int n from deliveries d join certificates c on c.id = d.certificate_id where c.batch_id = ${id} and d.status = 'SENT'`))[0]!.n === 1);
    const st = await q<{ status: string }>(sql`select status from deliveries where certificate_id = ${certs[0]!.id}`);
    expect(st[0]!.status).toBe("SKIPPED");
  });
});

describe("NEVER #4: a stranger gets someone else's certificate or personal details", () => {
  it("random or guessed download tokens give nothing; a token only ever unlocks its own certificate", async () => {
    const id = await newBatch(w, 2); await approveFully(w, id);
    const certs = await waitFor(async () => { const r = await q<{ number: string; token: string }>(sql`select number, download_token as token from certificates where batch_id = ${id} and status='ISSUED' order by number`); return r.length === 2 ? r : false; });
    await api().get("/api/public/certificates/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/download").expect(404);
    await api().get("/api/public/certificates/..%2F..%2Fetc%2Fpasswd/download").expect(404);
    const pdf = await api().get(`/api/public/certificates/${certs[0]!.token}/download`).expect(200);
    expect(pdf.headers["content-disposition"]).toContain(certs[0]!.number);
    expect(pdf.headers["content-disposition"]).not.toContain(certs[1]!.number);
  });

  it("staff of another district/centre cannot read certificates, timelines or lists", async () => {
    const id = await newBatch(w, 2); await approveFully(w, id);
    const [c] = await q<{ id: string }>(sql`select id from certificates where batch_id = ${id} limit 1`);
    for (const who of ["rohan", "sunita"] as const) {
      expect((await api().get(`/api/certificates/${c!.id}/pdf`).set(as(w, who))).status).toBe(404);
      expect((await api().get(`/api/certificates/${c!.id}/timeline`).set(as(w, who))).status).toBe(404);
      expect((await api().get(`/api/batches/${id}/certificates`).set(as(w, who))).status).toBe(404);
      expect((await api().get("/api/certificates").set(as(w, who))).body).toEqual([]);
    }
    expect((await api().get(`/api/certificates/${c!.id}/pdf`).set(as(w, "dev"))).status).toBe(200); // the right district can
    expect((await api().get(`/api/certificates/${c!.id}/pdf`)).status).toBe(401);
  });

  it("the public verify response never contains phone, email, score or internal ids", async () => {
    const [c] = await q<{ number: string }>(sql`select number from certificates where status = 'ISSUED' limit 1`);
    const body = JSON.stringify((await api().get(`/api/public/verify/${c!.number}`)).body);
    expect(body).not.toMatch(/\+91|@|score|phone|email|batch|token|[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });

  it("list and detail responses for staff do not leak the download token or storage keys", async () => {
    const id = (await q<{ id: string }>(sql`select id from batches where status = 'APPROVED' limit 1`))[0]!.id;
    const body = JSON.stringify((await api().get(`/api/batches/${id}/certificates`).set(as(w, "farah"))).body) + JSON.stringify((await api().get("/api/certificates").set(as(w, "farah"))).body);
    expect(body).not.toMatch(/downloadToken|download_token|fileKey|\.pdf/);
  });
});

describe("NEVER #5: a decision that cannot be traced to who made it and when", () => {
  it("every decision writes an audit row with actor, role, time and request id - in the same transaction", async () => {
    const id = await newBatch(w, 3); await submit(w, id);
    const rid = "trace-req-0001-abcdef";
    await api().post(`/api/batches/${id}/decision`).set(as(w, "dev")).set("x-request-id", rid).send({ decision: "approve" }).expect(200);
    await decision(w, id, "meera", "send_back", "Needs another look");
    const rows = await q<{ actor_id: string; actor_name: string; actor_role: string; action: string; at: Date; request_id: string | null }>(sql`select actor_id, actor_name, actor_role, action, at, request_id from audit_log where batch_id = ${id} order by id`);
    const vote = rows.find((r) => r.action === "batch.vote_approve")!;
    expect(vote).toMatchObject({ actor_id: w.ids.dev, actor_name: "Dev", actor_role: "district_officer", request_id: rid });
    expect(Number.isNaN(new Date(vote.at).getTime())).toBe(false);
    const back = rows.find((r) => r.action === "batch.sent_back")!;
    expect(back).toMatchObject({ actor_id: w.ids.meera, actor_role: "district_officer" });
    expect(rows.every((r) => r.actor_name && r.actor_role && r.at)).toBe(true);
  });

  it("failed or rejected attempts leave no phantom 'success' records (audit commits with the change or not at all)", async () => {
    const id = await newBatch(w, 2); await submit(w, id);
    const before = (await q<{ n: number }>(sql`select count(*)::int n from audit_log where batch_id = ${id}`))[0]!.n;
    await decision(w, id, "farah", "approve"); // forbidden
    await decision(w, id, "dev", "reject"); // 422 reason missing
    expect((await q<{ n: number }>(sql`select count(*)::int n from audit_log where batch_id = ${id}`))[0]!.n).toBe(before);
  });

  it("the audit log is append-only: UPDATE, DELETE and TRUNCATE are refused by the database", async () => {
    await dbRejects(db.execute(sql`update audit_log set actor_name = 'someone else'`), /append-only/);
    await dbRejects(db.execute(sql`delete from audit_log`), /append-only/);
    await dbRejects(db.execute(sql`truncate audit_log`), /append-only/);
  });

  it("system actions (certificate issued, escalation) are attributed to a named system component", async () => {
    const rows = await q<{ actor_name: string; actor_id: string | null }>(sql`select distinct actor_name, actor_id from audit_log where action = 'certificate.issued'`);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.actor_name === "system:worker" && r.actor_id === null)).toBe(true);
  });

  it("the whole story of a batch can be read back end to end", async () => {
    const id = (await q<{ id: string }>(sql`select id from batches where status = 'APPROVED' limit 1`))[0]!.id;
    const t = await api().get(`/api/batches/${id}/timeline`).set(as(w, "farah")).expect(200);
    const actions = (t.body.events as { action: string }[]).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["batch.created", "batch.candidates_imported", "batch.submitted", "batch.vote_approve", "batch.advanced", "batch.certificates_created", "certificate.issued"]));
    const first = (await q<{ id: string }>(sql`select id from certificates where batch_id = ${id} limit 1`))[0]!.id;
    const ct = await api().get(`/api/certificates/${first}/timeline`).set(as(w, "farah")).expect(200);
    expect(ct.body.delivery).toBeTruthy();
    expect(ct.body.certificate.downloadToken).toBeUndefined();
  });
});
