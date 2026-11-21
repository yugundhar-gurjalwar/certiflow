import http from "node:http";
import { Worker } from "bullmq";
import { config } from "./config.js";
import { pool } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { handleDomainEvent, handleGenerate, handleSend } from "./jobs/handlers.js";
import { closeQueues, QUEUE_NAMES } from "./jobs/queues.js";
import { relayOnce } from "./jobs/relay.js";
import { sweepOnce } from "./jobs/sweeper.js";
import { logger } from "./logger.js";
import { newBlockingConnection, redis } from "./redis.js";

/**
 * The background process. Scale it by running more replicas: every piece is safe to run concurrently
 * (SKIP LOCKED relay, atomic delivery claims, jobId dedupe, UNIQUE-guarded escalations).
 */
export async function startWorker() {
  await runMigrations();
  const workers = [
    new Worker(QUEUE_NAMES.events, (job) => handleDomainEvent(job.data), { connection: newBlockingConnection(), concurrency: 5 }),
    new Worker(QUEUE_NAMES.generate, (job) => handleGenerate(job.data), { connection: newBlockingConnection(), concurrency: config.WORKER_CONCURRENCY }),
    new Worker(QUEUE_NAMES.send, (job) => handleSend(job.data), { connection: newBlockingConnection(), concurrency: config.WORKER_CONCURRENCY }),
  ];
  for (const w of workers) w.on("failed", (job, err) => logger.error({ queue: w.name, jobId: job?.id, err: err.message }, "job failed"));

  let stopping = false;
  const loop = async (name: string, everyMs: number, fn: () => Promise<unknown>) => {
    while (!stopping) {
      try { await fn(); } catch (e) { logger.error({ loop: name, err: String(e) }, "loop iteration failed"); }
      await new Promise((r) => setTimeout(r, everyMs));
    }
  };
  void loop("relay", config.OUTBOX_POLL_MS, async () => { while ((await relayOnce()) > 0) { /* drain */ } });
  void loop("sweeper", config.SWEEP_INTERVAL_MS, () => sweepOnce());

  const port = Number(process.env.WORKER_HEALTH_PORT ?? 4001);
  const health = http.createServer(async (req, res) => {
    if (req.url === "/health") { res.writeHead(200).end("ok"); return; }
    try { await pool.query("select 1"); await redis.ping(); res.writeHead(200).end("ready"); } catch { res.writeHead(503).end("not ready"); }
  }).listen(port);

  logger.info({ port }, "worker started");
  /** `force` abandons in-flight jobs (simulates a crash). `closeShared` also closes the pool/redis (process exit). */
  const stop = async ({ force = false, closeShared = false } = {}) => {
    stopping = true;
    await Promise.all(workers.map((w) => w.close(force)));
    health.close();
    if (closeShared) {
      await closeQueues();
      await pool.end();
      redis.disconnect();
    }
  };
  return { stop };
}

if (/worker\.(ts|js)$/.test(process.argv[1] ?? "") && process.env.NODE_ENV !== "test") {
  process.env.SERVICE_NAME ??= "worker";
  startWorker().then(({ stop }) => {
    for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => void stop({ closeShared: true }).then(() => process.exit(0)));
  }).catch((e) => { console.error(e); process.exit(1); });
}
