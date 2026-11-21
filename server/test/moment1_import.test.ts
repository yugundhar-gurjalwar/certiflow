import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, as, csvFor, makeWorld, newBatch, q, resetAll, shutdown, type World } from "./helpers.js";

/** MOMENT 1: upload a spreadsheet with bad rows -> exact errors reported, nothing half-saved. */
let w: World;
beforeAll(async () => { await resetAll(); w = await makeWorld(); });
afterAll(() => shutdown());

const upload = (id: string, content: string | Buffer, name = "b.csv", who: "anika" | "rohan" = "anika") =>
  api().post(`/api/batches/${id}/import`).set(as(w, who)).attach("file", Buffer.from(content), name);

describe("moment 1: spreadsheet import is all-or-nothing", () => {
  it("reports exact row/column errors and saves NOTHING", async () => {
    const good = csvFor(5, { prefix: "G" });
    const id = await newBatch(w, 5, { csv: good });
    const before = await q<{ n: number }>(sqlCount(id));
    expect(before[0]!.n).toBe(5);

    const lines = csvFor(40, { prefix: "H" }).trim().split("\n");
    lines[10] = "H-0010,Bad Phone,12345,,80"; // row 11
    lines[20] = "H-0020,,9876500020,,80"; // row 21: missing name
    lines[30] = "H-0030,Low Score,9876500030,,10"; // row 31: below pass mark
    const res = await upload(id, lines.join("\n"));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("IMPORT_REJECTED");
    const errs = res.body.error.details.errors as { row: number; column: string; code: string }[];
    expect(errs.map((e) => `${e.row}:${e.column}:${e.code}`)).toEqual(["11:phone:INVALID_PHONE", "21:full_name:REQUIRED", "31:score:BELOW_PASS_MARK"]);

    // nothing half-saved: the previous 5 candidates are intact, none of the 37 good rows of the bad file leaked in
    const after = await q<{ n: number; first: string }>(sqlCount(id));
    expect(after[0]!.n).toBe(5);
    const names = await q<{ enrolment_no: string }>(sqlNames(id));
    expect(names.every((r) => r.enrolment_no.startsWith("G-"))).toBe(true);
  });

  it("a corrected file imports completely and replaces the draft's list", async () => {
    const id = await newBatch(w, 3);
    const res = await upload(id, csvFor(45, { prefix: "OK" }));
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(45);
    expect((await q<{ n: number }>(sqlCount(id)))[0]!.n).toBe(45);
  });

  it("rejects unreadable / wrong files without touching data", async () => {
    const id = await newBatch(w, 2);
    expect((await upload(id, "just,one,line\n")).status).toBe(422);
    expect((await upload(id, "x", "evil.exe")).status).toBe(415);
    expect((await upload(id, Buffer.alloc(3 * 1024 * 1024, 65))).status).toBe(413);
    expect((await q<{ n: number }>(sqlCount(id)))[0]!.n).toBe(2);
  });

  it("refuses a phone that is already in another live batch for the same course", async () => {
    const shared = csvFor(2, { prefix: "S" });
    const a = await newBatch(w, 2, { csv: shared });
    await api().post(`/api/batches/${a}/submit`).set(as(w, "anika")).expect(200);
    const b = await newBatch(w, 1);
    const res = await upload(b, shared.replace(/S-/g, "T-"));
    expect(res.status).toBe(422);
    expect(res.body.error.details.errors.every((e: { code: string }) => e.code === "ALREADY_IN_ANOTHER_BATCH")).toBe(true);
  });

  it("only the owning centre can import into a batch", async () => {
    const id = await newBatch(w, 1);
    expect((await upload(id, csvFor(1), "b.csv", "rohan")).status).toBe(404); // other centre cannot even see it
  });
});

import { sql } from "drizzle-orm";
const sqlCount = (id: string) => sql`select count(*)::int as n from candidates where batch_id = ${id}`;
const sqlNames = (id: string) => sql`select enrolment_no from candidates where batch_id = ${id}`;

describe("moment 1 (xlsx): the same rules apply to Excel files", () => {
  it("imports a real .xlsx and reports row-level errors from one too", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const build = async (rows: (string | number)[][]) => {
      const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("Batch");
      rows.forEach((r) => ws.addRow(r));
      return Buffer.from(await wb.xlsx.writeBuffer());
    };
    const header = ["enrolment_no", "full_name", "phone", "email", "score"];
    const id = await newBatch(w, 1);
    const ok = await upload(id, await build([header, ["X-001", "Asha Rao", 9876501234, "", 81], ["X-002", "Ravi Kumar", "9876501235", "", 77]]), "sheet.xlsx");
    expect(ok.status).toBe(200);
    expect(ok.body.imported).toBe(2);
    const bad = await upload(id, await build([header, ["X-001", "Asha Rao", "12345", "", 81]]), "sheet.xlsx");
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.errors[0]).toMatchObject({ row: 2, column: "phone", code: "INVALID_PHONE" });
    expect((await q<{ n: number }>(sqlCount(id)))[0]!.n).toBe(2); // earlier good import untouched
  });
});
