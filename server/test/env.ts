// Runs before every test file: point everything at the TEST database/redis db and make timing fast.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5432/certiflow_test";
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379/1";
process.env.STORAGE_DIR = mkdtempSync(path.join(tmpdir(), "certiflow-test-"));
process.env.WHATSAPP_TIMEOUT_MS = "400";
process.env.DELIVERY_BACKOFF_BASE_MS = "30";
process.env.DELIVERY_BACKOFF_MAX_MS = "250";
process.env.OUTBOX_POLL_MS = "30";
process.env.SWEEP_INTERVAL_MS = "200";
process.env.STALE_CLAIM_MS = "600";
process.env.ESCALATION_LEVEL1_MINUTES = "60";
process.env.ESCALATION_LEVEL2_MINUTES = "120";
process.env.WORKER_HEALTH_PORT = "0";
process.env.DEMO_MODE = "true";
