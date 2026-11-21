import client from "prom-client";
import { sql } from "drizzle-orm";
import { db } from "./db/client.js";
import { getQueue, QUEUE_NAMES } from "./jobs/queues.js";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const httpDuration = new client.Histogram({
  name: "http_request_duration_seconds", help: "HTTP latency", labelNames: ["method", "route", "status"],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], registers: [registry],
});

// Business gauges are read from the database when Prometheus scrapes, so they are right even after restarts.
new client.Gauge({
  name: "certiflow_deliveries", help: "Deliveries by status", labelNames: ["status"], registers: [registry],
  async collect() {
    this.reset();
    const r = await db.execute<{ status: string; n: number }>(sql`select status, count(*)::int as n from deliveries group by status`);
    for (const row of r.rows) this.set({ status: row.status }, row.n);
  },
});
new client.Gauge({
  name: "certiflow_batches", help: "Batches by status", labelNames: ["status"], registers: [registry],
  async collect() {
    this.reset();
    const r = await db.execute<{ status: string; n: number }>(sql`select status, count(*)::int as n from batches group by status`);
    for (const row of r.rows) this.set({ status: row.status }, row.n);
  },
});
new client.Gauge({
  name: "certiflow_outbox_unpublished", help: "Outbox rows not yet relayed (should hover near 0)", registers: [registry],
  async collect() {
    const r = await db.execute<{ n: number }>(sql`select count(*)::int as n from outbox where published_at is null`);
    this.set(r.rows[0]?.n ?? 0);
  },
});
new client.Gauge({
  name: "certiflow_oldest_waiting_batch_seconds", help: "Age of the batch that has waited longest in a review stage", registers: [registry],
  async collect() {
    const r = await db.execute<{ s: number | null }>(sql`select extract(epoch from (now() - min(stage_entered_at)))::int as s from batches where status in ('DISTRICT_REVIEW','QUALITY_REVIEW','STATE_REVIEW')`);
    this.set(r.rows[0]?.s ?? 0);
  },
});
new client.Gauge({
  name: "certiflow_queue_jobs", help: "BullMQ jobs by queue and state", labelNames: ["queue", "state"], registers: [registry],
  async collect() {
    this.reset();
    try {
      for (const name of Object.values(QUEUE_NAMES)) {
        const c = await getQueue(name).getJobCounts("waiting", "active", "delayed", "failed");
        for (const [state, n] of Object.entries(c)) this.set({ queue: name, state }, n);
      }
    } catch { /* redis down */ }
  },
});
