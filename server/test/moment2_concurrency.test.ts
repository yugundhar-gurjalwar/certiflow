import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { as, api, approveFully, decision, makeWorld, newBatch, q, resetAll, shutdown, submit, type World } from "./helpers.js";
import { sql } from "drizzle-orm";

/** MOMENT 2: two district officers approve the same batch at the same moment -> it moves forward ONCE. */
let w: World;
beforeAll(async () => { await resetAll(); w = await makeWorld(); });
afterAll(() => shutdown());

const advancedEvents = (id: string) => q<{ n: number }>(sql`select count(*)::int as n from audit_log where batch_id = ${id} and action = 'batch.advanced'`).then((r) => r[0]!.n);
const status = async (id: string) => (await api().get(`/api/batches/${id}`).set(as(w, "farah"))).body.status as string;

describe("moment 2: concurrent approvals", () => {
  it("one approval alone does not move a batch (more than one officer must agree)", async () => {
    const id = await newBatch(w, 5); await submit(w, id);
    expect((await decision(w, id, "dev", "approve")).status).toBe(200);
    expect(await status(id)).toBe("DISTRICT_REVIEW");
  });

  it("two officers approving simultaneously advance the batch exactly once (repeated 25x)", async () => {
    for (let i = 0; i < 25; i++) {
      const id = await newBatch(w, 3); await submit(w, id);
      const [a, b] = await Promise.all([decision(w, id, "dev", "approve"), decision(w, id, "meera", "approve")]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(await status(id)).toBe("STATE_REVIEW");
      expect(await advancedEvents(id)).toBe(1); // moved forward once, not twice
      const votes = await q<{ n: number }>(sql`select count(*)::int as n from approvals where batch_id = ${id}`);
      expect(votes[0]!.n).toBe(2);
      // exactly one outbox event announces the move
      const ev = await q<{ n: number }>(sql`select count(*)::int as n from outbox where aggregate_id = ${id} and topic = 'batch.advanced' and payload->>'to' = 'STATE_REVIEW'`);
      expect(ev[0]!.n).toBe(1);
    }
  });

  it("three officers racing: two win, the late one gets a clean 409 and nothing is double-counted", async () => {
    const id = await newBatch(w, 3); await submit(w, id);
    const rs = await Promise.all((["dev", "meera", "kabir"] as const).map((p) => decision(w, id, p, "approve")));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 200, 409]);
    expect(await advancedEvents(id)).toBe(1);
    expect(await status(id)).toBe("STATE_REVIEW");
  });

  it("the same officer double-clicking counts once", async () => {
    const id = await newBatch(w, 3); await submit(w, id);
    const rs = await Promise.all([decision(w, id, "dev", "approve"), decision(w, id, "dev", "approve"), decision(w, id, "dev", "approve")]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect((await q<{ n: number }>(sql`select count(*)::int as n from approvals where batch_id = ${id}`))[0]!.n).toBe(1);
    expect(await status(id)).toBe("DISTRICT_REVIEW");
  });

  it("final approval racing with itself creates certificates once", async () => {
    const id = await newBatch(w, 6); await submit(w, id);
    await decision(w, id, "dev", "approve"); await decision(w, id, "meera", "approve");
    const rs = await Promise.all([decision(w, id, "farah", "approve"), decision(w, id, "farah", "approve")]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await q<{ n: number }>(sql`select count(*)::int as n from certificates where batch_id = ${id}`))[0]!.n).toBe(6);
    expect((await q<{ n: number }>(sql`select count(*)::int as n from outbox where aggregate_id = ${id} and topic = 'batch.approved'`))[0]!.n).toBe(1);
  });

  it("a large batch is held for quality review and cannot skip it", async () => {
    const id = await newBatch(w, 55); await submit(w, id);
    await decision(w, id, "dev", "approve"); await decision(w, id, "meera", "approve");
    expect(await status(id)).toBe("QUALITY_REVIEW");
    expect((await decision(w, id, "farah", "approve")).status).toBe(403); // state cannot act at the quality step
    expect((await decision(w, id, "neha", "approve")).status).toBe(200);
    expect(await status(id)).toBe("STATE_REVIEW");
    void approveFully;
  });
});
