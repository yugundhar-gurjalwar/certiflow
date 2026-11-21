import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startSseHub } from "../src/http/sse.js";
import { publish } from "../src/services/realtime.js";
import { app, api, as, makeWorld, resetAll, shutdown, waitFor, type World } from "./helpers.js";

/** "Everyone sees changes live without refreshing": SSE stream, one-time tickets, per-role scoping. */
let w: World; let stopHub: () => void; let server: http.Server; let base: string;
beforeAll(async () => {
  await resetAll(); w = await makeWorld(); stopHub = startSseHub();
  server = http.createServer(app); await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { stopHub(); server.closeAllConnections(); server.close(); await shutdown(); });

async function connect(who: Parameters<typeof as>[1]) {
  const { ticket } = (await api().post("/api/events/ticket").set(as(w, who))).body as { ticket: string };
  const received: string[] = [];
  let ready = false;
  const req = http.get(`${base}/api/events?ticket=${ticket}`, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => { for (const m of chunk.matchAll(/event: (\S+)\ndata: (.*)\n/g)) { if (m[1] === "ready") ready = true; else received.push(m[1]!); } });
  });
  await waitFor(async () => ready, { what: "stream ready" });
  return { ticket, received, close: () => req.destroy() };
}

describe("live updates", () => {
  it("delivers events to the right people only (centre, district, state) and nobody else", async () => {
    const anika = await connect("anika"); const rohan = await connect("rohan"); const dev = await connect("dev"); const sunita = await connect("sunita"); const farah = await connect("farah");
    await publish({ type: "batch.changed", batchId: "b1", centreId: w.centreA, districtId: w.hyd });
    await waitFor(async () => anika.received.length && dev.received.length && farah.received.length, { what: "events" });
    await new Promise((r) => setTimeout(r, 150));
    expect(anika.received).toEqual(["batch.changed"]);
    expect(dev.received).toEqual(["batch.changed"]);
    expect(farah.received).toEqual(["batch.changed"]);
    expect(rohan.received).toEqual([]); // other centre
    expect(sunita.received).toEqual([]); // other district
    await publish({ type: "notification", userId: w.ids.dev });
    await waitFor(async () => dev.received.length === 2, { what: "targeted event" });
    expect(anika.received).toHaveLength(1);
    [anika, rohan, dev, sunita, farah].forEach((c) => c.close());
  });

  it("a ticket works once and only briefly; no token means no stream", async () => {
    const c = await connect("dev");
    const reuse = await api().get(`/api/events?ticket=${c.ticket}`);
    expect(reuse.status).toBe(401);
    expect((await api().get("/api/events")).status).toBe(401);
    expect((await api().post("/api/events/ticket")).status).toBe(401);
    c.close();
  });
});
