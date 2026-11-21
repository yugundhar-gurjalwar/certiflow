import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, as, makeWorld, newBatch, q, resetAll, shutdown, type World } from "./helpers.js";

/** Tampered requests and bad input cannot fool the system. */
let w: World;
beforeAll(async () => { await resetAll(); w = await makeWorld(); });
afterAll(() => shutdown());

describe("hostile input", () => {
  it("malformed or oversized JSON is a clean 4xx, never a stack trace", async () => {
    const bad = await api().post("/api/batches").set(as(w, "anika")).set("content-type", "application/json").send("{not json");
    expect(bad.status).toBe(400);
    const big = await api().post("/api/batches").set(as(w, "anika")).send({ name: "x".repeat(300_000), courseCode: "WELD-101" });
    expect(big.status).toBe(413);
    expect(JSON.stringify(bad.body)).not.toMatch(/at .*\.ts|node_modules/);
  });

  it("ids are validated: non-UUIDs never reach the database", async () => {
    for (const bad of ["1", "abc", "'; drop table batches;--", "../etc"]) {
      const r = await api().get(`/api/batches/${encodeURIComponent(bad)}`).set(as(w, "farah"));
      expect(r.status).toBe(400);
    }
  });

  it("SQL-looking and HTML-looking text is stored as plain text and the schema survives", async () => {
    const r = await api().post("/api/batches").set(as(w, "anika")).send({ name: "Robert'); DROP TABLE batches;-- <script>alert(1)</script>", courseCode: "WELD-101" });
    expect(r.status).toBe(201);
    expect((await q<{ n: number }>(sql`select count(*)::int n from batches`))[0]!.n).toBeGreaterThan(0);
    expect(r.headers["content-type"]).toMatch(/json/); // never rendered as HTML by the API
  });

  it("body fields outside the contract are ignored or refused (mass assignment)", async () => {
    const r = await api().post("/api/batches").set(as(w, "anika")).send({ name: "Mass assign", courseCode: "WELD-101", status: "APPROVED", districtId: w.wgl, centreId: w.centreB, round: 9 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "DRAFT", centreId: w.centreA, districtId: w.hyd, round: 1 });
  });

  it("an unknown decision value, empty body, or wrong types are refused", async () => {
    const id = await newBatch(w, 2);
    await api().post(`/api/batches/${id}/submit`).set(as(w, "anika")).expect(200);
    for (const body of [{}, { decision: "approve_all" }, { decision: ["approve"] }, { decision: "reject", reason: 123 }]) {
      expect((await api().post(`/api/batches/${id}/decision`).set(as(w, "dev")).send(body)).status).toBe(400);
    }
  });

  it("spreadsheet formula injection is rejected at import", async () => {
    const id = await newBatch(w, 1);
    const csv = ["enrolment_no,full_name,phone,email,score", 'E-1,"=HYPERLINK(""http://evil"")",9876543210,,80', "E-2,Asha Rao,9876543211,=cmd@x.com,80"].join("\n") + "\n";
    const r = await api().post(`/api/batches/${id}/import`).set(as(w, "anika")).attach("file", Buffer.from(csv), "x.csv");
    expect(r.status).toBe(422);
    expect(r.body.error.details.errors.map((e: { code: string }) => e.code)).toEqual(["INVALID_NAME", "INVALID_EMAIL"]);
  });

  it("login is rate limited and does not reveal whether an email exists", async () => {
    const wrongPw = await api().post("/api/auth/login").send({ email: "anika@t.test", password: "nope" });
    const noUser = await api().post("/api/auth/login").send({ email: "ghost@t.test", password: "nope" });
    expect(wrongPw.status).toBe(401); expect(noUser.status).toBe(401);
    expect(wrongPw.body.error.message).toBe(noUser.body.error.message);
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await api().post("/api/auth/login").send({ email: "ghost@t.test", password: "x" })).status;
    expect(last).toBe(429);
  });

  it("security headers are present and the API does not advertise its framework", async () => {
    const r = await api().get("/health");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-powered-by"]).toBeUndefined();
    expect(r.headers["x-request-id"]).toBeTruthy();
  });

  it("unexpected server errors do not leak internals", async () => {
    const r = await api().get("/api/this-route-does-not-exist").set(as(w, "farah"));
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("NOT_FOUND");
  });
});
