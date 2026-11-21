import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, as, csvFor, decision, expectOk, makeWorld, newBatch, q, resetAll, shutdown, submit, type World } from "./helpers.js";

/** MOMENT 6: officer sends batch back, centre fixes and resends -> what happens to approvals it already had is a deliberate decision (docs/DECISIONS.md D-6). */
let w: World;
beforeAll(async () => { await resetAll(); w = await makeWorld(); });
afterAll(() => shutdown());

const get = async (id: string, who: "anika" | "dev" | "farah" = "farah") => (await api().get(`/api/batches/${id}`).set(as(w, who))).body;

describe("moment 6: send back, fix, resend", () => {
  it("send-back needs a reason, tells the centre why, and unlocks editing", async () => {
    const id = await newBatch(w, 4); await submit(w, id);
    await decision(w, id, "dev", "approve");
    expect((await decision(w, id, "meera", "send_back")).status).toBe(422); // reason mandatory
    expect((await decision(w, id, "meera", "send_back", "Two phone numbers look wrong")).status).toBe(200);
    const b = await get(id, "anika");
    expect(b.status).toBe("CHANGES_REQUESTED");
    expect(b.lastReason).toBe("Two phone numbers look wrong");
    // officers can no longer vote on it, the centre can edit and resubmit
    expect((await decision(w, id, "kabir", "approve")).status).toBe(409);
    const notif = await q<{ message: string }>(sql`select message from notifications where user_id = ${w.ids.anika} and kind = 'sent_back'`);
    expect(notif[0]!.message).toContain("Two phone numbers look wrong");
  });

  it("D-6: approvals from before the send-back are void after resubmission - the whole district review restarts", async () => {
    const id = await newBatch(w, 4); await submit(w, id);
    expectOk(await decision(w, id, "dev", "approve"));
    expectOk(await decision(w, id, "meera", "send_back", "Please correct the scores"));
    await api().post(`/api/batches/${id}/import`).set(as(w, "anika")).attach("file", Buffer.from(csvFor(4, { prefix: "FIX" })), "fixed.csv").expect(200);
    await api().post(`/api/batches/${id}/submit`).set(as(w, "anika")).expect(200);

    let b = await get(id);
    expect(b.status).toBe("DISTRICT_REVIEW");
    expect(b.round).toBe(2);
    // Dev's old approval is still in history but does NOT count: one new approval is not a quorum.
    expectOk(await decision(w, id, "meera", "approve"));
    expect((await get(id)).status).toBe("DISTRICT_REVIEW");
    // Dev must vote again in the new round (allowed, because it is a new round)
    expectOk(await decision(w, id, "dev", "approve"));
    b = await get(id);
    expect(b.status).toBe("STATE_REVIEW");
    // nothing was lost: history keeps all votes, tagged by round
    const rounds = (b.votes as { round: number }[]).map((v) => v.round).sort();
    expect(rounds).toEqual([1, 2, 2]);
    // and the audit trail says exactly how many approvals were voided
    const resub = await q<{ details: { earlierApprovalsVoided: number; round: number } }>(sql`select details from audit_log where batch_id = ${id} and action = 'batch.resubmitted'`);
    expect(resub[0]!.details).toMatchObject({ earlierApprovalsVoided: 1, round: 2 });
  });

  it("an officer's correction during review also voids votes already cast (reviewers approved different data)", async () => {
    const id = await newBatch(w, 3); await submit(w, id);
    expectOk(await decision(w, id, "dev", "approve"));
    const cand = (await get(id)).candidates[0];
    const fix = await api().patch(`/api/batches/${id}/candidates/${cand.id}`).set(as(w, "meera")).send({ fullName: "Corrected Name" });
    expect(fix.status).toBe(200);
    expect(fix.body).toMatchObject({ newRound: 2, votesVoided: 1 });
    expectOk(await decision(w, id, "kabir", "approve"));
    expect((await get(id)).status).toBe("DISTRICT_REVIEW"); // Dev's vote no longer counts
    const audit = await q<{ details: { before: { fullName: string }; after: { fullName: string } } }>(sql`select details from audit_log where batch_id = ${id} and action = 'batch.candidate_corrected'`);
    expect(audit[0]!.details.after.fullName).toBe("Corrected Name"); // before/after recorded
    expect(audit[0]!.details.before.fullName).not.toBe("Corrected Name");
  });

  it("only officers of that district can correct, only during district review, never the score", async () => {
    const id = await newBatch(w, 2); await submit(w, id);
    const cand = (await get(id)).candidates[0];
    await api().patch(`/api/batches/${id}/candidates/${cand.id}`).set(as(w, "sunita")).send({ fullName: "Hacker" }).expect(404);
    await api().patch(`/api/batches/${id}/candidates/${cand.id}`).set(as(w, "anika")).send({ fullName: "Hacker" }).expect(403);
    const r = await api().patch(`/api/batches/${id}/candidates/${cand.id}`).set(as(w, "dev")).send({ score: 100 });
    expect(r.status).toBe(400); // nothing editable in the body
  });

  it("a rejected batch is final", async () => {
    const id = await newBatch(w, 2); await submit(w, id);
    expectOk(await decision(w, id, "dev", "reject", "Centre is not accredited for this course"));
    expect((await get(id)).status).toBe("DISTRICT_REVIEW"); // one reject is not a district decision
    expectOk(await decision(w, id, "meera", "reject", "Centre is not accredited for this course"));
    expect((await get(id)).status).toBe("REJECTED");
    await api().post(`/api/batches/${id}/submit`).set(as(w, "anika")).expect(409);
  });
});
