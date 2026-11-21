import { sql } from "drizzle-orm";
import request from "supertest";
import { createSim } from "../../whatsapp-sim/src/sim.js";
import { hashPassword } from "../src/auth/password.js";
import { signToken } from "../src/auth/middleware.js";
import { config } from "../src/config.js";
import { db, pool, schema } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { createApp } from "../src/http/app.js";
import { closeQueues } from "../src/jobs/queues.js";
import { redis } from "../src/redis.js";
import { startWorker } from "../src/worker.js";

export const app = createApp();
export const api = () => request(app);

export async function resetAll() {
  await runMigrations();
  await db.execute(sql`alter table audit_log disable trigger user`); // the trigger forbids TRUNCATE; tests may reset
  await db.execute(sql`truncate table notifications, escalations, outbox, deliveries, certificates, approvals, candidates, batches, users, courses, centres, districts, audit_log restart identity cascade`);
  await db.execute(sql`alter table audit_log enable trigger user`);
  await db.execute(sql`alter sequence certificate_number_seq restart with 100001`);
  await redis.flushdb();
}

export async function shutdown(worker?: { stop: (o?: { force?: boolean; closeShared?: boolean }) => Promise<void> }) {
  if (worker) await worker.stop();
  await closeQueues();
  await pool.end();
  redis.disconnect();
}

export type Persona = "anika" | "dev" | "meera" | "kabir" | "neha" | "farah" | "rohan" | "sunita";
export interface World {
  ids: Record<Persona, string>;
  token: Record<Persona, string>;
  hyd: string; wgl: string; centreA: string; centreB: string;
}

let hash: string | undefined;
export async function makeWorld(): Promise<World> {
  hash ??= await hashPassword("pw-for-tests");
  const [hyd, wgl] = await db.insert(schema.districts).values([{ name: "Hyderabad" }, { name: "Warangal" }]).returning();
  const [cA, cB] = await db.insert(schema.centres).values([{ name: "Centre A (Hyderabad)", districtId: hyd!.id }, { name: "Centre B (Warangal)", districtId: wgl!.id }]).returning();
  await db.insert(schema.courses).values([{ code: "WELD-101", name: "Welding Fundamentals", passScore: 40 }, { code: "EVT-201", name: "EV Technician", passScore: 50 }]);
  const mk = (name: string, role: string, extra: object) => ({ name, email: `${name.toLowerCase()}@t.test`, role, passwordHash: hash!, ...extra });
  const rows = await db.insert(schema.users).values([
    mk("Anika", "centre", { centreId: cA!.id }), mk("Dev", "district_officer", { districtId: hyd!.id }),
    mk("Meera", "district_officer", { districtId: hyd!.id }), mk("Kabir", "district_officer", { districtId: hyd!.id }),
    mk("Neha", "quality", {}), mk("Farah", "state", {}),
    mk("Rohan", "centre", { centreId: cB!.id }), mk("Sunita", "district_officer", { districtId: wgl!.id }),
  ]).returning();
  const ids = {} as Record<Persona, string>; const token = {} as Record<Persona, string>;
  for (const r of rows) { const k = r.name.toLowerCase() as Persona; ids[k] = r.id; token[k] = signToken(r.id); }
  return { ids, token, hyd: hyd!.id, wgl: wgl!.id, centreA: cA!.id, centreB: cB!.id };
}

let phoneCounter = 0;
export const nextPhone = () => { do { phoneCounter++; } while ((9_000_000_000 + phoneCounter) % 10_000 === 0); return `+91${9_000_000_000 + phoneCounter}`; };
export function csvFor(n: number, opts: { prefix?: string; score?: number } = {}): string {
  const prefix = opts.prefix ?? "ENR";
  const lines = ["enrolment_no,full_name,phone,email,score"];
  for (let i = 1; i <= n; i++) lines.push(`${prefix}-${String(i).padStart(4, "0")},Trainee ${String.fromCharCode(65 + (i % 26))}${"x".repeat(i % 5)} Kumar,${nextPhone()},,${opts.score ?? 75}`);
  return lines.join("\n") + "\n";
}

export const as = (w: World, who: Persona) => ({ Authorization: `Bearer ${w.token[who]}` });

export async function newBatch(w: World, n: number, opts: { name?: string; course?: string; csv?: string; who?: Persona } = {}) {
  const who = opts.who ?? "anika";
  const create = await api().post("/api/batches").set(as(w, who)).send({ name: opts.name ?? `Batch of ${n}`, courseCode: opts.course ?? "WELD-101" });
  if (create.status !== 201) throw new Error(`create failed ${create.status} ${JSON.stringify(create.body)}`);
  const id = create.body.id as string;
  const imp = await api().post(`/api/batches/${id}/import`).set(as(w, who)).attach("file", Buffer.from(opts.csv ?? csvFor(n)), "batch.csv");
  if (imp.status !== 200) throw new Error(`import failed ${imp.status} ${JSON.stringify(imp.body)}`);
  return id;
}
export async function submit(w: World, id: string, who: Persona = "anika") {
  const r = await api().post(`/api/batches/${id}/submit`).set(as(w, who));
  if (r.status !== 200) throw new Error(`submit failed ${r.status} ${JSON.stringify(r.body)}`);
}
export const decision = (w: World, id: string, who: Persona, d: "approve" | "reject" | "send_back", reason?: string) =>
  api().post(`/api/batches/${id}/decision`).set(as(w, who)).send({ decision: d, reason });

/** Drive a batch through every stage to APPROVED via the real API. */
export async function approveFully(w: World, id: string, large = false) {
  await submit(w, id);
  for (const who of ["dev", "meera"] as const) expectOk(await decision(w, id, who, "approve"));
  if (large) expectOk(await decision(w, id, "neha", "approve"));
  expectOk(await decision(w, id, "farah", "approve"));
}
export function expectOk<T extends { status: number; body: any }>(r: T): T { if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${JSON.stringify(r.body)}`); return r; }

export async function waitFor<T>(fn: () => Promise<T | false | undefined | null>, { timeoutMs = 30_000, intervalMs = 100, what = "condition" } = {}): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Real worker + the flaky WhatsApp stand-in, wired together in-process. */
export async function startPipeline(simConfig: Parameters<typeof createSim>[0] = {}) {
  const sim = createSim(simConfig);
  const port = await sim.listen(0);
  config.WHATSAPP_URL = `http://127.0.0.1:${port}`;
  const worker = await startWorker();
  return { sim, worker, stop: async () => { await worker.stop(); await sim.close(); } };
}

export const q = <T = Record<string, unknown>>(query: ReturnType<typeof sql>) => db.execute(query).then((r) => r.rows as T[]);
