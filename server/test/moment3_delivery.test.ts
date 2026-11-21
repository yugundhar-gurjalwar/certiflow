import { createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { redis } from "../src/redis.js";
import { sweepOnce } from "../src/jobs/sweeper.js";
import { api, approveFully, as, expectOk, decision, makeWorld, newBatch, q, resetAll, shutdown, startPipeline, submit, waitFor, type World } from "./helpers.js";

/** MOMENT 3: batch of 60 approved -> every candidate ends with exactly ONE certificate on their phone, though WhatsApp is unreliable. */
let w: World;
let pipe: Awaited<ReturnType<typeof startPipeline>>;
beforeAll(async () => { await resetAll(); w = await makeWorld(); pipe = await startPipeline(); });
afterAll(async () => { await pipe.stop(); await shutdown(); });

const counts = async (batchId: string) => ({
  certs: (await q<{ n: number }>(sql`select count(*)::int n from certificates where batch_id = ${batchId}`))[0]!.n,
  distinct: (await q<{ n: number }>(sql`select count(distinct number)::int n from certificates where batch_id = ${batchId}`))[0]!.n,
  issued: (await q<{ n: number }>(sql`select count(*)::int n from certificates where batch_id = ${batchId} and status = 'ISSUED'`))[0]!.n,
  deliveries: (await q<{ n: number }>(sql`select count(*)::int n from deliveries d join certificates c on c.id = d.certificate_id where c.batch_id = ${batchId}`))[0]!.n,
  sent: (await q<{ n: number }>(sql`select count(*)::int n from deliveries d join certificates c on c.id = d.certificate_id where c.batch_id = ${batchId} and d.status in ('SENT','DELIVERED')`))[0]!.n,
});
const allSent = (id: string, n: number) => waitFor(async () => (await counts(id)).sent === n, { timeoutMs: 40_000, what: `${n} deliveries sent` });

describe("moment 3: 60 certificates through an unreliable WhatsApp", () => {
  it("random 500s + accept-then-timeouts + 429s: still exactly one message per candidate", async () => {
    pipe.sim.cfg.failureRate = 0.3; pipe.sim.cfg.timeoutRate = 0.15; pipe.sim.cfg.rateLimitRate = 0.1; pipe.sim.cfg.hangMs = 1500;
    const id = await newBatch(w, 60);
    await approveFully(w, id, true);
    await allSent(id, 60);

    const c = await counts(id);
    expect(c).toMatchObject({ certs: 60, distinct: 60, issued: 60, deliveries: 60, sent: 60 });
    // The provider really was hostile...
    expect(pipe.sim.stats.failures500).toBeGreaterThan(0);
    expect(pipe.sim.stats.timeoutsInjected).toBeGreaterThan(0);
    // ...and still each candidate's phone holds exactly one message.
    const msgs = [...pipe.sim.messages.values()];
    expect(msgs).toHaveLength(60);
    expect(new Set(msgs.map((m) => m.to)).size).toBe(60);
    const attempts = (await q<{ s: number }>(sql`select sum(attempts)::int s from deliveries`))[0]!.s;
    expect(attempts).toBeGreaterThan(60); // retries really happened
  });

  it("provider outage: deliveries wait, nothing is lost, everything goes out when it recovers", async () => {
    pipe.sim.cfg.failureRate = 0; pipe.sim.cfg.timeoutRate = 0; pipe.sim.cfg.rateLimitRate = 0; pipe.sim.cfg.outage = true;
    const id = await newBatch(w, 8);
    await approveFully(w, id);
    await waitFor(async () => (await counts(id)).issued === 8, { what: "certificates issued even during outage" }); // slow provider never blocks issuing
    await new Promise((r) => setTimeout(r, 500));
    expect((await counts(id)).sent).toBe(0);
    pipe.sim.cfg.outage = false;
    await allSent(id, 8);
    expect(new Set([...pipe.sim.messages.values()].map((m) => m.to)).size).toBe(68);
  });

  it("after the retry budget is exhausted the delivery is dead-lettered and the state office can re-queue it", async () => {
    const saved = config.DELIVERY_MAX_ATTEMPTS; config.DELIVERY_MAX_ATTEMPTS = 3; pipe.sim.cfg.outage = true;
    const id = await newBatch(w, 2); await approveFully(w, id);
    await waitFor(async () => (await q<{ n: number }>(sql`select count(*)::int n from deliveries where status = 'DEAD'`))[0]!.n >= 2, { what: "dead letters" });
    pipe.sim.cfg.outage = false; config.DELIVERY_MAX_ATTEMPTS = saved;
    const ops = expectOk(await api().get("/api/ops/overview").set(as(w, "farah")));
    expect(ops.body.deliveryProblems.length).toBeGreaterThanOrEqual(2);
    for (const p of ops.body.deliveryProblems) expectOk(await api().post(`/api/certificates/${p.certificateId}/redeliver`).set(as(w, "farah")));
    await allSent(id, 2);
  });

  it("redis wiped + worker killed mid-flight: the sweeper rebuilds the work from the database", async () => {
    pipe.sim.cfg.failureRate = 0.2; pipe.sim.cfg.latencyMs = 40;
    const id = await newBatch(w, 20);
    await approveFully(w, id);
    await redis.flushdb(); // Redis "restart": every queued job vanishes
    await pipe.worker.stop({ force: true }); // worker crash
    const { startWorker } = await import("../src/worker.js");
    pipe.worker = await startWorker(); // a fresh replica comes up
    await allSent(id, 20);
    expect((await counts(id))).toMatchObject({ certs: 20, issued: 20, deliveries: 20, sent: 20 });
    pipe.sim.cfg.failureRate = 0; pipe.sim.cfg.latencyMs = 0;
  });

  it("a delivery abandoned mid-send by a crashed worker is reclaimed and sent once", async () => {
    const id = await newBatch(w, 1); await approveFully(w, id);
    const [d] = await waitFor(async () => { const r = await q<{ id: string }>(sql`select d.id from deliveries d join certificates c on c.id = d.certificate_id where c.batch_id = ${id}`); return r.length ? r : false; });
    await waitFor(async () => (await counts(id)).sent === 1);
    // Simulate: worker claimed it, then died. Provider already has the message (we reuse the same idempotency key).
    await q(sql`update deliveries set status = 'SENDING', locked_at = now() - interval '5 minutes' where id = ${d!.id}`);
    const before = pipe.sim.messages.size;
    await sweepOnce();
    await waitFor(async () => (await q<{ status: string }>(sql`select status from deliveries where id = ${d!.id}`))[0]!.status === "SENT");
    expect(pipe.sim.messages.size).toBe(before); // provider deduplicated by Idempotency-Key: no second message
    expect(pipe.sim.stats.duplicatesSuppressed).toBeGreaterThan(0);
  });

  it("a signed provider webhook marks the delivery DELIVERED; unsigned/forged ones are rejected", async () => {
    const id = await newBatch(w, 1); await approveFully(w, id);
    await allSent(id, 1);
    const [d] = await q<{ id: string }>(sql`select d.id from deliveries d join certificates c on c.id = d.certificate_id where c.batch_id = ${id}`);
    const body = JSON.stringify({ client_ref: d!.id, status: "delivered" });
    await api().post("/webhooks/whatsapp").set("x-signature", "deadbeef").set("content-type", "application/json").send(body).expect(401);
    const sig = createHmac("sha256", config.WEBHOOK_SECRET).update(body).digest("hex");
    await api().post("/webhooks/whatsapp").set("x-signature", sig).set("content-type", "application/json").send(body).expect(200);
    expect((await q<{ status: string }>(sql`select status from deliveries where id = ${d!.id}`))[0]!.status).toBe("DELIVERED");
    void decision; void submit;
  });
});
