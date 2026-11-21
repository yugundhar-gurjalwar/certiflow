import pino from "pino";
import { config } from "./config.js";

/** JSON logs. Every line about a batch/certificate carries batchId / certificateId / requestId so one
 *  grep (or one Loki/CloudWatch query) reconstructs what happened. */
export const logger = pino({
  level: config.NODE_ENV === "test" ? "silent" : config.LOG_LEVEL,
  base: { service: process.env.SERVICE_NAME ?? "certiflow" },
  redact: ["req.headers.authorization", "req.headers.cookie", "*.password", "*.phone"],
});
