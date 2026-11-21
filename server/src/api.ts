import { config } from "./config.js";
import { pool } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { createApp } from "./http/app.js";
import { startSseHub } from "./http/sse.js";
import { closeQueues } from "./jobs/queues.js";
import { logger } from "./logger.js";
import { redis } from "./redis.js";

process.env.SERVICE_NAME ??= "api";

async function main() {
  await runMigrations(); // advisory-locked, so many replicas starting together is fine
  const stopSse = startSseHub();
  const server = createApp().listen(config.PORT, () => logger.info({ port: config.PORT }, "api listening"));
  const stop = async () => {
    logger.info("shutting down");
    stopSse();
    server.close();
    await closeQueues();
    await pool.end();
    redis.disconnect();
    process.exit(0);
  };
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => void stop());
}

main().catch((e) => { console.error(e); process.exit(1); });
