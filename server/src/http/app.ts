import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import cors from "cors";
import express, { type ErrorRequestHandler, type Request } from "express";
import helmet from "helmet";
import multer from "multer";
import { pinoHttp } from "pino-http";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { authenticate, requireRole, signToken } from "../auth/middleware.js";
import { verifyPassword } from "../auth/password.js";
import { config } from "../config.js";
import { db, pool, schema } from "../db/client.js";
import { readGrid } from "../domain/csv.js";
import { logger } from "../logger.js";
import { registry, httpDuration } from "../metrics.js";
import { redis } from "../redis.js";
import { decide } from "../services/approvals.js";
import {
  correctCandidate, createBatch, deleteDraftBatch, getBatchDetail, importCandidates, listBatches, submitBatch,
} from "../services/batches.js";
import {
  cancelCertificate, candidateCertificateFile, listBatchCertificates, searchCertificates, staffCertificateFile,
} from "../services/certificates.js";
import { applyProviderStatus, requeueDelivery } from "../services/deliveries.js";
import { overview } from "../services/ops.js";
import { batchTimeline, certificateTimeline } from "../services/timeline.js";
import { verifyCertificate } from "../services/verify.js";
import { AppError, badRequest, notFound } from "./errors.js";
import { rateLimit } from "./rateLimit.js";
import { issueTicket, openStream } from "./sse.js";
import { parse, uuid } from "./validate.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 }, // 2 MB is ~20k rows; anything bigger is not a candidate sheet
  fileFilter: (_req, file, cb) => (/\.(csv|xlsx)$/i.test(file.originalname) ? cb(null, true) : cb(new AppError(415, "UNSUPPORTED_FILE", "Upload a .csv or .xlsx file"))),
});

const asyncH = <T extends (req: Request, res: express.Response) => Promise<unknown>>(fn: T): express.RequestHandler =>
  (req, res, next) => { fn(req, res).catch(next); };

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin: config.CORS_ORIGIN.split(","), credentials: false }));

  // Correlation id: accept a sane inbound one (from a proxy), otherwise make one. Echoed back and stored in audit rows.
  app.use((req, res, next) => {
    const inbound = req.headers["x-request-id"];
    req.requestId = typeof inbound === "string" && /^[\w-]{8,64}$/.test(inbound) ? inbound : randomUUID();
    res.setHeader("x-request-id", req.requestId);
    next();
  });
  app.use(pinoHttp({
    logger, genReqId: (req) => (req as Request).requestId ?? randomUUID(),
    customProps: (req) => ({ requestId: (req as Request).requestId, userId: (req as Request).actor?.id }),
    autoLogging: { ignore: (req) => req.url === "/health" || req.url === "/metrics" },
  }));
  app.use((req, res, next) => {
    const end = httpDuration.startTimer();
    res.on("finish", () => end({ method: req.method, route: req.route?.path ?? "unmatched", status: String(res.statusCode) }));
    next();
  });

  // ---- Webhook (raw body, HMAC-signed by the provider). Mounted BEFORE express.json ----
  app.post("/webhooks/whatsapp", express.raw({ type: "*/*", limit: "50kb" }), asyncH(async (req, res) => {
    const sig = String(req.headers["x-signature"] ?? "");
    const expected = createHmac("sha256", config.WEBHOOK_SECRET).update(req.body as Buffer).digest("hex");
    const ok = sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    if (!ok) throw new AppError(401, "BAD_SIGNATURE", "Invalid signature");
    const body = parse(z.object({ client_ref: z.string(), status: z.enum(["delivered", "read", "failed"]), id: z.string().optional() }), JSON.parse((req.body as Buffer).toString("utf8")));
    const changed = await applyProviderStatus(body.client_ref, body.status, body.id);
    res.json({ ok: true, changed });
  }));

  app.use(express.json({ limit: "100kb" }));

  // ---- Health / metrics ----
  app.get("/health", (_req, res) => { res.json({ ok: true }); });
  app.get("/ready", asyncH(async (_req, res) => {
    const checks = { postgres: false, redis: false };
    try { await pool.query("select 1"); checks.postgres = true; } catch { /* */ }
    try { await redis.ping(); checks.redis = true; } catch { /* */ }
    res.status(checks.postgres && checks.redis ? 200 : 503).json(checks);
  }));
  app.get("/metrics", asyncH(async (_req, res) => { res.type(registry.contentType).send(await registry.metrics()); }));

  // ---- Public (no login) ----
  const pub = express.Router();
  pub.get("/meta", (_req, res) => {
    res.json({ districtQuorum: config.DISTRICT_QUORUM, largeBatchThreshold: config.LARGE_BATCH_THRESHOLD, escalationLevel1Minutes: config.ESCALATION_LEVEL1_MINUTES, escalationLevel2Minutes: config.ESCALATION_LEVEL2_MINUTES, demoMode: config.DEMO_MODE });
  });
  pub.get("/verify/:number", rateLimit("verify", 120, 60), asyncH(async (req, res) => {
    const result = await verifyCertificate(String(req.params.number));
    res.setHeader("Cache-Control", "no-store"); // a cancelled certificate must never be served from a browser/CDN cache
    res.json(result);
  }));
  pub.get("/certificates/:token/download", rateLimit("download", 60, 60), asyncH(async (req, res) => {
    const f = await candidateCertificateFile(String(req.params.token));
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${f.number}.pdf"`);
    res.setHeader("Cache-Control", "private, no-store");
    f.stream.pipe(res);
  }));
  app.use("/api/public", pub);

  // ---- Auth ----
  const auth = express.Router();
  auth.post("/login", rateLimit("login", 10, 60), asyncH(async (req, res) => {
    const { email, password } = parse(z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) }), req.body);
    const [u] = await db.select().from(schema.users).where(eq(schema.users.email, email.toLowerCase()));
    const ok = u?.active && (await verifyPassword(password, u.passwordHash));
    if (!u || !ok) throw new AppError(401, "BAD_CREDENTIALS", "Wrong email or password"); // same message for both cases
    res.json({ token: signToken(u.id), user: { id: u.id, name: u.name, role: u.role } });
  }));
  auth.get("/demo-users", asyncH(async (_req, res) => {
    if (!config.DEMO_MODE) throw notFound();
    const rows = await db.select({ name: schema.users.name, email: schema.users.email, role: schema.users.role }).from(schema.users).where(eq(schema.users.active, true));
    res.json({ password: config.DEMO_PASSWORD, users: rows });
  }));
  auth.get("/me", authenticate, (req, res) => { res.json(req.actor); });
  app.use("/api/auth", auth);

  // ---- Everything below needs a logged-in user ----
  const api = express.Router();
  api.use(authenticate);
  api.use(rateLimit("api", 600, 60, (req) => req.actor!.id));

  api.get("/courses", asyncH(async (_req, res) => { res.json(await db.select().from(schema.courses)); }));

  // Batches
  const idParam = (req: Request, name = "id") => parse(uuid, req.params[name]);
  api.post("/batches", requireRole("centre"), asyncH(async (req, res) => {
    const input = parse(z.object({ name: z.string().trim().min(3).max(120), courseCode: z.string().min(2).max(30) }), req.body);
    res.status(201).json(await createBatch(req.actor!, input, req.requestId));
  }));
  api.get("/batches", asyncH(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status.split(",").filter(Boolean) : undefined;
    res.json(await listBatches(req.actor!, { status }));
  }));
  api.get("/batches/:id", asyncH(async (req, res) => { res.json(await getBatchDetail(req.actor!, idParam(req))); }));
  api.delete("/batches/:id", requireRole("centre"), asyncH(async (req, res) => { await deleteDraftBatch(req.actor!, idParam(req), req.requestId); res.status(204).end(); }));
  api.post("/batches/:id/import", requireRole("centre"), upload.single("file"), asyncH(async (req, res) => {
    if (!req.file) throw badRequest("Attach the spreadsheet as form field 'file'");
    let grid: string[][];
    try { grid = await readGrid(req.file.buffer, req.file.originalname); }
    catch { throw new AppError(422, "UNREADABLE_FILE", "Could not read the file as a spreadsheet. Is it a real .csv or .xlsx?"); }
    res.json(await importCandidates(req.actor!, idParam(req), grid, req.requestId));
  }));
  api.post("/batches/:id/submit", requireRole("centre"), asyncH(async (req, res) => { res.json(await submitBatch(req.actor!, idParam(req), req.requestId)); }));
  api.post("/batches/:id/decision", requireRole("district_officer", "quality", "state"), asyncH(async (req, res) => {
    const input = parse(z.object({ decision: z.enum(["approve", "reject", "send_back"]), reason: z.string().trim().max(1000).optional() }), req.body);
    res.json(await decide(req.actor!, idParam(req), input, req.requestId));
  }));
  api.patch("/batches/:id/candidates/:cid", requireRole("district_officer"), asyncH(async (req, res) => {
    const patch = parse(z.object({
      fullName: z.string().trim().min(2).max(100).regex(/^[\p{L}\p{M}][\p{L}\p{M} .'\-]*$/u, "letters, spaces and . ' - only").optional(),
      phone: z.string().trim().max(20).optional(),
      email: z.string().trim().email().max(120).nullable().optional(),
    }).refine((v) => Object.keys(v).length > 0, "Nothing to change"), req.body);
    res.json(await correctCandidate(req.actor!, idParam(req), idParam(req, "cid"), patch, req.requestId));
  }));
  api.get("/batches/:id/timeline", asyncH(async (req, res) => { res.json(await batchTimeline(req.actor!, idParam(req))); }));
  api.get("/batches/:id/certificates", asyncH(async (req, res) => { res.json(await listBatchCertificates(req.actor!, idParam(req))); }));

  // Certificates
  api.get("/certificates", asyncH(async (req, res) => {
    res.json(await searchCertificates(req.actor!, typeof req.query.q === "string" ? req.query.q.slice(0, 60) : undefined));
  }));
  api.get("/certificates/:id/pdf", asyncH(async (req, res) => {
    const f = await staffCertificateFile(req.actor!, idParam(req));
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${f.number}.pdf"`);
    res.setHeader("Cache-Control", "private, no-store");
    f.stream.pipe(res);
  }));
  api.get("/certificates/:id/timeline", asyncH(async (req, res) => { res.json(await certificateTimeline(req.actor!, idParam(req))); }));
  api.post("/certificates/:id/cancel", requireRole("state"), asyncH(async (req, res) => {
    const { reason } = parse(z.object({ reason: z.string().trim().min(5).max(500) }), req.body);
    res.json(await cancelCertificate(req.actor!, idParam(req), reason, req.requestId));
  }));
  api.post("/certificates/:id/redeliver", requireRole("state"), asyncH(async (req, res) => {
    const id = await requeueDelivery(idParam(req));
    if (!id) throw new AppError(409, "NOT_RETRYABLE", "Only dead or permanently failed deliveries can be re-queued");
    res.json({ requeued: true });
  }));

  // Ops + notifications + live stream
  api.get("/ops/overview", requireRole("state", "quality"), asyncH(async (_req, res) => { res.json(await overview()); }));
  api.get("/notifications", asyncH(async (req, res) => {
    const rows = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, req.actor!.id)).orderBy(schema.notifications.createdAt).limit(200);
    res.json(rows.reverse());
  }));
  api.post("/notifications/read-all", asyncH(async (req, res) => {
    await db.update(schema.notifications).set({ readAt: new Date() }).where(eq(schema.notifications.userId, req.actor!.id));
    res.json({ ok: true });
  }));
  api.post("/events/ticket", asyncH(async (req, res) => { res.json({ ticket: await issueTicket(req.actor!) }); }));
  // The stream authenticates with the one-time ticket, not a bearer header, so it must be registered BEFORE the
  // bearer-token router (a router-level authenticate runs for every path under /api, matched or not).
  app.get("/api/events", asyncH(async (req, res) => { await openStream(req, res); }));
  app.use("/api", api);

  app.use((_req, _res, next) => next(notFound("Route")));
  const onError: ErrorRequestHandler = (err, req, res, _next) => {
    if (err instanceof AppError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details, requestId: req.requestId } });
      return;
    }
    if (err instanceof multer.MulterError) {
      res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: { code: err.code, message: err.message, requestId: req.requestId } });
      return;
    }
    if ((err as { type?: string }).type === "entity.parse.failed" || err instanceof SyntaxError) {
      res.status(400).json({ error: { code: "BAD_JSON", message: "Malformed JSON body", requestId: req.requestId } });
      return;
    }
    if ((err as { type?: string }).type === "entity.too.large") {
      res.status(413).json({ error: { code: "TOO_LARGE", message: "Request body too large", requestId: req.requestId } });
      return;
    }
    logger.error({ err, requestId: req.requestId, path: req.path }, "unhandled error");
    res.status(500).json({ error: { code: "INTERNAL", message: "Something went wrong", requestId: req.requestId } }); // no internals leaked
  };
  app.use(onError);
  return app;
}
