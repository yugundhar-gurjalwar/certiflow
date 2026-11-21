import { sql } from "drizzle-orm";
import {
  bigserial, boolean, check, index, integer, jsonb, pgSequence, pgTable, text,
  timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";

/**
 * Schema notes (the "why" is in docs/DECISIONS.md):
 *  - The database enforces the safety rules (unique constraints, CHECKs, append-only audit trigger),
 *    so a bug in application code cannot silently break them.
 *  - Row ids are uuids; human-facing numbers (certificate numbers) come from a sequence.
 */

export const certificateSeq = pgSequence("certificate_number_seq", { startWith: 100001, increment: 1 });

export const districts = pgTable("districts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
});

export const centres = pgTable("centres", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  districtId: uuid("district_id").notNull().references(() => districts.id),
});

export const courses = pgTable("courses", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  passScore: integer("pass_score").notNull(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").notNull(), // centre | district_officer | quality | state
    centreId: uuid("centre_id").references(() => centres.id),
    districtId: uuid("district_id").references(() => districts.id),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("users_role_chk", sql`${t.role} in ('centre','district_officer','quality','state')`),
    // A role's scope must be present: centre users have a centre, district officers a district.
    check(
      "users_scope_chk",
      sql`(${t.role} <> 'centre' or ${t.centreId} is not null) and (${t.role} <> 'district_officer' or ${t.districtId} is not null)`,
    ),
  ],
);

export const batches = pgTable(
  "batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    courseCode: text("course_code").notNull().references(() => courses.code),
    centreId: uuid("centre_id").notNull().references(() => centres.id),
    districtId: uuid("district_id").notNull().references(() => districts.id),
    // DRAFT | DISTRICT_REVIEW | QUALITY_REVIEW | STATE_REVIEW | CHANGES_REQUESTED | REJECTED | APPROVED
    status: text("status").notNull().default("DRAFT"),
    // Bumped every time reviewed content changes (resubmission or officer correction). Votes only count
    // for the round they were cast in -> see docs/DECISIONS.md D-6.
    round: integer("round").notNull().default(1),
    requiresQuality: boolean("requires_quality").notNull().default(false),
    candidateCount: integer("candidate_count").notNull().default(0),
    stageEnteredAt: timestamp("stage_entered_at", { withTimezone: true }).notNull().defaultNow(),
    lastReason: text("last_reason"),
    createdBy: uuid("created_by").notNull().references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "batches_status_chk",
      sql`${t.status} in ('DRAFT','DISTRICT_REVIEW','QUALITY_REVIEW','STATE_REVIEW','CHANGES_REQUESTED','REJECTED','APPROVED')`,
    ),
    index("batches_status_idx").on(t.status, t.stageEnteredAt),
    index("batches_centre_idx").on(t.centreId),
    index("batches_district_idx").on(t.districtId, t.status),
  ],
);

export const candidates = pgTable(
  "candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id").notNull().references(() => batches.id, { onDelete: "cascade" }),
    enrolmentNo: text("enrolment_no").notNull(),
    fullName: text("full_name").notNull(),
    phone: text("phone").notNull(), // E.164, e.g. +919876543210
    email: text("email"),
    score: integer("score").notNull(),
    courseCode: text("course_code").notNull(),
  },
  (t) => [
    uniqueIndex("candidates_batch_enrol_uq").on(t.batchId, t.enrolmentNo),
    uniqueIndex("candidates_batch_phone_uq").on(t.batchId, t.phone),
    index("candidates_phone_idx").on(t.courseCode, t.phone),
  ],
);

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id").notNull().references(() => batches.id),
    round: integer("round").notNull(),
    stage: text("stage").notNull(), // DISTRICT_REVIEW | QUALITY_REVIEW | STATE_REVIEW
    officerId: uuid("officer_id").notNull().references(() => users.id),
    decision: text("decision").notNull(), // approve | reject
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One vote per officer per stage per round, enforced by the database: this is what makes
    // "the same officer clicking twice" harmless.
    uniqueIndex("approvals_vote_uq").on(t.batchId, t.round, t.stage, t.officerId),
    check("approvals_decision_chk", sql`${t.decision} in ('approve','reject')`),
  ],
);

export const certificates = pgTable(
  "certificates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // UNIQUE: a candidate can never have two certificates (never-happen #2).
    candidateId: uuid("candidate_id").notNull().unique().references(() => candidates.id),
    batchId: uuid("batch_id").notNull().references(() => batches.id),
    // UNIQUE: two certificates can never share a number.
    number: text("number").notNull().unique(),
    // Denormalised from the candidate so the database can enforce "one ACTIVE certificate per person per
    // course" across batches (partial unique index below). A cancelled certificate frees the slot.
    courseCode: text("course_code").notNull(),
    phone: text("phone").notNull(),
    status: text("status").notNull().default("PENDING"), // PENDING | ISSUED | CANCELLED
    downloadToken: text("download_token").notNull().unique(),
    fileKey: text("file_key"),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: uuid("cancelled_by").references(() => users.id),
    cancelReason: text("cancel_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("certificates_status_chk", sql`${t.status} in ('PENDING','ISSUED','CANCELLED')`),
    check(
      "certificates_cancel_chk",
      sql`(${t.status} <> 'CANCELLED') or (${t.cancelledAt} is not null and ${t.cancelledBy} is not null and ${t.cancelReason} is not null)`,
    ),
    index("certificates_batch_idx").on(t.batchId, t.status),
    uniqueIndex("certificates_one_active_per_person_uq")
      .on(t.courseCode, t.phone)
      .where(sql`${t.status} <> 'CANCELLED'`),
  ],
);

export const deliveries = pgTable(
  "deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // UNIQUE: exactly one logical WhatsApp delivery per certificate. Retries re-use this row
    // (and its id as the provider idempotency key) instead of creating new ones.
    certificateId: uuid("certificate_id").notNull().unique().references(() => certificates.id),
    // QUEUED | SENDING | RETRY | SENT | DELIVERED | FAILED_PERMANENT | DEAD | SKIPPED
    status: text("status").notNull().default("QUEUED"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    providerMessageId: text("provider_message_id"),
    lastError: text("last_error"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "deliveries_status_chk",
      sql`${t.status} in ('QUEUED','SENDING','RETRY','SENT','DELIVERED','FAILED_PERMANENT','DEAD','SKIPPED')`,
    ),
    index("deliveries_due_idx").on(t.status, t.nextAttemptAt),
  ],
);

export const outbox = pgTable(
  "outbox",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    topic: text("topic").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    payload: jsonb("payload").notNull().default({}),
    requestId: text("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => [index("outbox_unpublished_idx").on(t.id).where(sql`${t.publishedAt} is null`)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    // actor is null only for system actors; then actorName = 'system:<component>'
    actorId: uuid("actor_id"),
    actorName: text("actor_name").notNull(),
    actorRole: text("actor_role").notNull(),
    action: text("action").notNull(),
    batchId: uuid("batch_id"),
    certificateId: uuid("certificate_id"),
    details: jsonb("details").notNull().default({}),
    requestId: text("request_id"),
  },
  (t) => [index("audit_batch_idx").on(t.batchId, t.at), index("audit_cert_idx").on(t.certificateId, t.at)],
);

export const escalations = pgTable(
  "escalations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id").notNull().references(() => batches.id),
    round: integer("round").notNull(),
    stage: text("stage").notNull(),
    level: integer("level").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Exactly one escalation per (batch, round, stage, level) no matter how many schedulers run.
  (t) => [uniqueIndex("escalations_once_uq").on(t.batchId, t.round, t.stage, t.level)],
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id),
    batchId: uuid("batch_id").references(() => batches.id),
    kind: text("kind").notNull(),
    message: text("message").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.createdAt)],
);
