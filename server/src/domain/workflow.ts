import { config } from "../config.js";
import type { Role } from "../auth/actor.js";

/**
 * The batch state machine as plain data + pure functions (unit-testable without a database).
 *
 *  DRAFT ──submit──▶ DISTRICT_REVIEW ──(quorum approve)──▶ QUALITY_REVIEW ──▶ STATE_REVIEW ──▶ APPROVED
 *                          │                 (only batches >= LARGE_BATCH_THRESHOLD)  │
 *                          └──(skips quality for small batches)──────────────────────┘
 *  any review stage ──send back──▶ CHANGES_REQUESTED ──centre fixes + resubmits──▶ DISTRICT_REVIEW (round + 1)
 *  any review stage ──(reject quorum)──▶ REJECTED (terminal)
 */
export type Stage = "DISTRICT_REVIEW" | "QUALITY_REVIEW" | "STATE_REVIEW";
export type BatchStatus = "DRAFT" | Stage | "CHANGES_REQUESTED" | "REJECTED" | "APPROVED";

export const REVIEW_STAGES: readonly Stage[] = ["DISTRICT_REVIEW", "QUALITY_REVIEW", "STATE_REVIEW"];
export const isStage = (s: string): s is Stage => (REVIEW_STAGES as readonly string[]).includes(s);

/** Who owns each step. Nobody else may act on it. */
export const STAGE_ROLE: Record<Stage, Role> = {
  DISTRICT_REVIEW: "district_officer",
  QUALITY_REVIEW: "quality",
  STATE_REVIEW: "state",
};

export const STAGE_RANK: Record<Stage, number> = { DISTRICT_REVIEW: 1, QUALITY_REVIEW: 2, STATE_REVIEW: 3 };
export const STAGE_RANK_BY_ROLE: Partial<Record<Role, number>> = { district_officer: 1, quality: 2, state: 3 };

/** How many DISTINCT people must agree before a stage decision takes effect. */
export function quorumFor(stage: Stage): number {
  return stage === "DISTRICT_REVIEW" ? config.DISTRICT_QUORUM : 1;
}

export const requiresQualityReview = (candidateCount: number) => candidateCount >= config.LARGE_BATCH_THRESHOLD;

export function nextStatusOnApproval(stage: Stage, requiresQuality: boolean): BatchStatus {
  if (stage === "DISTRICT_REVIEW") return requiresQuality ? "QUALITY_REVIEW" : "STATE_REVIEW";
  if (stage === "QUALITY_REVIEW") return "STATE_REVIEW";
  return "APPROVED";
}

export const EDITABLE_BY_CENTRE: readonly BatchStatus[] = ["DRAFT", "CHANGES_REQUESTED"];

export type VoteTally = { approve: number; reject: number };
export type Outcome = "advance" | "reject" | "pending";
export function outcomeOf(stage: Stage, tally: VoteTally): Outcome {
  const q = quorumFor(stage);
  if (tally.approve >= q) return "advance";
  if (tally.reject >= q) return "reject";
  return "pending";
}
