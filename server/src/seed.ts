import { eq, sql } from "drizzle-orm";
import { hashPassword } from "./auth/password.js";
import type { Actor } from "./auth/actor.js";
import { config } from "./config.js";
import { db, pool, schema } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { redis } from "./redis.js";
import { decide } from "./services/approvals.js";
import { createBatch, importCandidates, submitBatch } from "./services/batches.js";

/**
 * Demo data. Idempotent: does nothing if users already exist. Batches are created through the SAME service
 * functions the API uses, so the demo data has a genuine audit trail and exercises the real rules.
 */
const FIRST = ["Aarav", "Vivaan", "Aditya", "Sai", "Arjun", "Krishna", "Ishaan", "Rohan", "Kiran", "Ravi", "Ananya", "Diya", "Isha", "Meera", "Priya", "Sneha", "Lakshmi", "Divya", "Pooja", "Kavya"];
const LAST = ["Reddy", "Sharma", "Rao", "Naidu", "Kumar", "Patel", "Singh", "Gupta", "Yadav", "Chowdary", "Verma", "Nair"];
let counter = 0;
function grid(n: number, prefix: string, score = 70): string[][] {
  const rows = [["enrolment_no", "full_name", "phone", "email", "score"]];
  for (let i = 0; i < n; i++) {
    counter++;
    const name = `${FIRST[counter % FIRST.length]} ${LAST[(counter * 7) % LAST.length]}`;
    rows.push([`${prefix}-${String(i + 1).padStart(3, "0")}`, name, `+91987650${String(counter).padStart(4, "0")}`, "", String(score + (counter % 25))]);
  }
  return rows;
}

async function main() {
  await runMigrations();
  const [{ n }] = (await db.execute<{ n: number }>(sql`select count(*)::int as n from users`)).rows as [{ n: number }];
  if (n > 0) { console.log("seed: data already present, skipping"); return; }

  const [hyd, wgl] = await db.insert(schema.districts).values([{ name: "Hyderabad" }, { name: "Warangal" }]).returning();
  const [c1, c2] = await db.insert(schema.centres).values([
    { name: "Pragati Skills Hub, Secunderabad", districtId: hyd!.id },
    { name: "Kakatiya Training Institute, Hanamkonda", districtId: wgl!.id },
  ]).returning();
  await db.insert(schema.courses).values([
    { code: "WELD-101", name: "Welding Fundamentals", passScore: 40 },
    { code: "EVT-201", name: "Electric Vehicle Technician", passScore: 50 },
    { code: "DATA-110", name: "Data Entry & Office Automation", passScore: 40 },
  ]);
  const pw = await hashPassword(config.DEMO_PASSWORD);
  const mk = (name: string, email: string, role: string, extra: Record<string, string>) => ({ name, email, role, passwordHash: pw, ...extra });
  const inserted = await db.insert(schema.users).values([
    mk("Anika", "anika@certiflow.demo", "centre", { centreId: c1!.id }),
    mk("Dev", "dev@certiflow.demo", "district_officer", { districtId: hyd!.id }),
    mk("Meera", "meera@certiflow.demo", "district_officer", { districtId: hyd!.id }),
    mk("Kabir", "kabir@certiflow.demo", "district_officer", { districtId: hyd!.id }),
    mk("Neha", "neha@certiflow.demo", "quality", {}),
    mk("Farah", "farah@certiflow.demo", "state", {}),
    // extra people to demonstrate district / centre isolation
    mk("Rohan (Warangal centre)", "rohan@certiflow.demo", "centre", { centreId: c2!.id }),
    mk("Sunita (Warangal officer)", "sunita@certiflow.demo", "district_officer", { districtId: wgl!.id }),
  ]).returning();
  const actor = (email: string): Actor => {
    const u = inserted.find((x) => x.email === `${email}@certiflow.demo`)!;
    return { id: u.id, name: u.name, role: u.role as Actor["role"], centreId: u.centreId, districtId: u.districtId };
  };
  const [anika, dev, meera, kabir, neha, farah] = ["anika", "dev", "meera", "kabir", "neha", "farah"].map(actor) as [Actor, Actor, Actor, Actor, Actor, Actor];

  // 1. A draft the centre is still working on
  const draft = await createBatch(anika, { name: "Welding Fundamentals - Nov (draft)", courseCode: "WELD-101" });
  await importCandidates(anika, draft.id, grid(12, "WLD-N"));

  // 2. Waiting for district review; Dev has already approved (1 of 2 needed)
  const b2 = await createBatch(anika, { name: "Data Entry - Oct Evening Batch", courseCode: "DATA-110" });
  await importCandidates(anika, b2.id, grid(18, "DE-O"));
  await submitBatch(anika, b2.id);
  await decide(dev, b2.id, { decision: "approve" });

  // 3. Large batch: district agreed, now waiting for the quality team (Neha)
  const b3 = await createBatch(anika, { name: "EV Technician - Autumn Cohort (large)", courseCode: "EVT-201" });
  await importCandidates(anika, b3.id, grid(60, "EV-A", 55));
  await submitBatch(anika, b3.id);
  await decide(dev, b3.id, { decision: "approve" });
  await decide(meera, b3.id, { decision: "approve" });

  // 4. Sent back by an officer: the centre must fix and resend
  const b4 = await createBatch(anika, { name: "Welding Fundamentals - Sep Batch", courseCode: "WELD-101" });
  await importCandidates(anika, b4.id, grid(15, "WLD-S"));
  await submitBatch(anika, b4.id);
  await decide(dev, b4.id, { decision: "approve" });
  await decide(kabir, b4.id, { decision: "send_back", reason: "Three phone numbers look like landlines; please confirm and resend." });

  // 5. Fully approved earlier: the worker issues PDFs and sends WhatsApp messages as soon as it starts
  const b5 = await createBatch(anika, { name: "Data Entry - Aug Morning Batch", courseCode: "DATA-110" });
  await importCandidates(anika, b5.id, grid(20, "DE-A"));
  await submitBatch(anika, b5.id);
  await decide(dev, b5.id, { decision: "approve" });
  await decide(meera, b5.id, { decision: "approve" });
  await decide(farah, b5.id, { decision: "approve" });

  // 6. Other district, to show isolation
  const rohan = actor("rohan");
  const b6 = await createBatch(rohan, { name: "Warangal - Welding Batch 7", courseCode: "WELD-101" });
  await importCandidates(rohan, b6.id, grid(10, "KT-W"));
  await submitBatch(rohan, b6.id);
  void neha;
  console.log("seed: demo data created (password for all demo users:", config.DEMO_PASSWORD + ")");
}

main().then(async () => { await pool.end(); redis.disconnect(); }).catch((e) => { console.error(e); process.exit(1); });
void eq;
