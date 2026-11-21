import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runEscalations } from "../src/services/escalation.js";
import { api, as, decision, makeWorld, newBatch, q, resetAll, shutdown, submit, type World } from "./helpers.js";

/** MOMENT 5: a batch untouched with an officer too long -> someone senior finds out without chasing. */
let w: World;
beforeAll(async () => { await resetAll(); w = await makeWorld(); });
afterAll(() => shutdown());

const age = (id: string, minutes: number) => q(sql`update batches set stage_entered_at = now() - make_interval(mins => ${minutes}) where id = ${id}`);
const notes = (user: string, kind?: string) => q<{ message: string; kind: string }>(sql`select message, kind from notifications where user_id = ${user} and kind like ${kind ?? "escalation%"}`);

describe("moment 5: escalation of stuck batches", () => {
  it("a fresh batch raises nothing", async () => {
    const id = await newBatch(w, 4); await submit(w, id);
    expect(await runEscalations()).toBe(0);
  });

  it("after the SLA, the officers who still owe a vote AND the state office are told - exactly once", async () => {
    const id = await newBatch(w, 4); await submit(w, id);
    await decision(w, id, "dev", "approve"); // Dev has done his part; Meera and Kabir have not
    await age(id, 61);
    expect(await runEscalations()).toBe(1);
    expect((await notes(w.ids.farah)).length).toBe(1);
    expect((await notes(w.ids.meera)).length).toBe(1);
    expect((await notes(w.ids.kabir)).length).toBe(1);
    expect((await notes(w.ids.dev)).length).toBe(0); // already voted, not chased
    expect((await notes(w.ids.sunita)).length).toBe(0); // other district untouched
    // running the scheduler again (or on 5 replicas at once) does not notify twice
    const again = await Promise.all([runEscalations(), runEscalations(), runEscalations(), runEscalations(), runEscalations()]);
    expect(again.reduce((a, b) => a + b, 0)).toBe(0);
    expect((await notes(w.ids.farah)).length).toBe(1);
    const audit = await q<{ n: number }>(sql`select count(*)::int n from audit_log where batch_id = ${id} and action = 'escalation.raised'`);
    expect(audit[0]!.n).toBe(1);
  });

  it("much later it becomes URGENT for the state office, again exactly once", async () => {
    const id = await newBatch(w, 4); await submit(w, id);
    await age(id, 130);
    expect(await runEscalations()).toBe(2); // level 1 and level 2 for this batch
    const urgent = await notes(w.ids.farah, "escalation_urgent");
    expect(urgent.filter((n) => n.message.includes("URGENT")).length).toBeGreaterThanOrEqual(1);
    expect(await runEscalations()).toBe(0);
  });

  it("the state office can see what is stuck without being chased, oldest first", async () => {
    const res = await api().get("/api/ops/overview").set(as(w, "farah")).expect(200);
    const stuck = res.body.stuckBatches as { waitingSeconds: number; name: string }[];
    expect(stuck.length).toBeGreaterThanOrEqual(2);
    expect([...stuck].sort((a, b) => b.waitingSeconds - a.waitingSeconds)).toEqual(stuck);
    await api().get("/api/ops/overview").set(as(w, "anika")).expect(403); // centres cannot see it
  });

  it("when the batch moves on, escalations for the old stage stop; a new stage gets a fresh clock", async () => {
    const id = await newBatch(w, 4); await submit(w, id);
    await decision(w, id, "dev", "approve"); await decision(w, id, "meera", "approve"); // now STATE_REVIEW, fresh clock
    expect(await runEscalations()).toBe(0);
  });
});
