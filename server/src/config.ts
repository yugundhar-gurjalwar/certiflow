import { z } from "zod";

/**
 * Every tunable lives here, validated once at start-up. A mis-typed env var fails the process
 * immediately instead of surfacing as odd behaviour at 2am.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().default("postgres://postgres@localhost:5432/certiflow"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  JWT_SECRET: z.string().min(16).default("dev-only-secret-change-me-please"),
  CERT_NUMBER_SECRET: z.string().min(16).default("dev-only-cert-number-secret"),
  WEBHOOK_SECRET: z.string().min(8).default("dev-webhook-secret"),
  PUBLIC_WEB_URL: z.string().default("http://localhost:8080"),
  CORS_ORIGIN: z.string().default("http://localhost:8080,http://localhost:5173"),
  DEMO_MODE: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  DEMO_PASSWORD: z.string().default("demo1234"),
  STORAGE_DIR: z.string().default("./data/certificates"),

  // Workflow rules
  DISTRICT_QUORUM: z.coerce.number().int().min(2).default(2),
  LARGE_BATCH_THRESHOLD: z.coerce.number().int().default(50),
  MAX_BATCH_ROWS: z.coerce.number().int().default(2000),

  // Escalation: minutes a batch may sit in a stage before seniors are told (level 1) / alarmed (level 2)
  ESCALATION_LEVEL1_MINUTES: z.coerce.number().default(24 * 60),
  ESCALATION_LEVEL2_MINUTES: z.coerce.number().default(48 * 60),

  // WhatsApp provider (stand-in)
  WHATSAPP_URL: z.string().default("http://localhost:4010"),
  WHATSAPP_TIMEOUT_MS: z.coerce.number().default(3000),
  DELIVERY_MAX_ATTEMPTS: z.coerce.number().default(25),
  DELIVERY_BACKOFF_BASE_MS: z.coerce.number().default(5000),
  DELIVERY_BACKOFF_MAX_MS: z.coerce.number().default(15 * 60 * 1000),

  // Background work
  WORKER_CONCURRENCY: z.coerce.number().default(10),
  OUTBOX_POLL_MS: z.coerce.number().default(300),
  SWEEP_INTERVAL_MS: z.coerce.number().default(15_000),
  STALE_CLAIM_MS: z.coerce.number().default(60_000),
  VERIFY_CACHE_TTL_S: z.coerce.number().default(60),
});

export type Config = z.infer<typeof schema>;
export const config: Config = schema.parse(process.env);
