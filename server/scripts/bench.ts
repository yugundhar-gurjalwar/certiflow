/**
 * Throughput measurement used for the numbers in DEPLOYMENT.md.
 *   usage: DATABASE_URL=... REDIS_URL=... npx tsx scripts/bench.ts 1000
 * Needs a running worker + WhatsApp stand-in (see SETUP.md) and the demo seed. Creates one big batch through the
 * same service functions as the API, approves it, then reports how long the pipeline takes to put every
 * certificate on a "phone". It exercises the real worker, so run it against a quiet environment.
 */
import { eq, sql } from "drizzle-orm";
import { db, pool, schema } from "../src/db/client.js";
import { decide } from "../src/services/approvals.js";
import { createBatch, importCandidates, submitBatch } from "../src/services/batches.js";
import { redis } from "../src/redis.js";
import type { Actor } from "../src/auth/actor.js";

const N = Number(process.argv[2] ?? 500);
const actorOf = async (email: string): Promise<Actor> => {
  const [u] = await db.select().from(schema.users).where(eq(schema.users.email, `${email}@certiflow.demo`));
  if (!u) throw new Error(`run the seed first (missing ${email})`);
  return { id: u.id, name: u.name, role: u.role as Actor["role"], centreId: u.centreId, districtId: u.districtId };
};

const [anika, dev, meera, neha, farah] = await Promise.all(["anika", "dev", "meera", "neha", "farah"].map(actorOf)) as [Actor, Actor, Actor, Actor, Actor];
const stamp = Date.now() % 1e7;
const rows = [["enrolment_no", "full_name", "phone", "email", "score"]];
const letters = (n: number) => { let out = ""; do { out = String.fromCharCode(97 + (n % 26)) + out; n = Math.floor(n / 26) - 1; } while (n >= 0); return out; };
for (let i = 0; i < N; i++) rows.push([`BN${stamp}-${i}`, `Bench ${letters(i)}`, `+91${8000000000 + ((stamp * 3000 + i) % 999999999)}`, "", "75"]);

const b = await createBatch(anika, { name: `Benchmark ${N} (${new Date().toISOString().slice(11, 19)})`, courseCode: "DATA-110" });
await importCandidates(anika, b.id, rows);
await submitBatch(anika, b.id);
await decide(dev, b.id, { decision: "approve" });
await decide(meera, b.id, { decision: "approve" });
await decide(neha, b.id, { decision: "approve" });
const t0 = Date.now();
await decide(farah, b.id, { decision: "approve" });
console.log(`approved at t=0; waiting for ${N} certificates to be issued and sent...`);

let issuedAt = 0;
for (;;) {
  const r = await db.execute<{ issued: number; sent: number }>(sql`
    select count(*) filter (where c.status = 'ISSUED')::int as issued,
           count(*) filter (where d.status in ('SENT','DELIVERED'))::int as sent
    from certificates c left join deliveries d on d.certificate_id = c.id where c.batch_id = ${b.id}`);
  const { issued, sent } = r.rows[0]!;
  if (!issuedAt && issued === N) { issuedAt = Date.now() - t0; console.log(`all ${N} PDFs issued after ${(issuedAt / 1000).toFixed(1)}s (${(N / (issuedAt / 1000)).toFixed(1)} certs/s)`); }
  if (sent === N) break;
  if (Date.now() - t0 > 30 * 60_000) { console.log("timeout"); break; }
  await new Promise((r) => setTimeout(r, 500));
}
const total = (Date.now() - t0) / 1000;
console.log(`all ${N} messages sent after ${total.toFixed(1)}s => ${(N / total).toFixed(1)} certificates/s end to end`);
await pool.end(); redis.disconnect();
process.exit(0);
