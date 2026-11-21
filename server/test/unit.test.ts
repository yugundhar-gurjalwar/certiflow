import { describe, expect, it } from "vitest";
import { hasValidCheckCode, makeCertificateNumber } from "../src/domain/certNumber.js";
import { normalisePhone, validateGrid } from "../src/domain/csv.js";
import { nextStatusOnApproval, outcomeOf, quorumFor, requiresQualityReview } from "../src/domain/workflow.js";

describe("workflow rules (pure)", () => {
  it("district decisions need more than one officer; other stages need one", () => {
    expect(quorumFor("DISTRICT_REVIEW")).toBeGreaterThan(1);
    expect(quorumFor("QUALITY_REVIEW")).toBe(1);
    expect(quorumFor("STATE_REVIEW")).toBe(1);
  });
  it("one approval is not enough at district level, two are", () => {
    expect(outcomeOf("DISTRICT_REVIEW", { approve: 1, reject: 0 })).toBe("pending");
    expect(outcomeOf("DISTRICT_REVIEW", { approve: 2, reject: 0 })).toBe("advance");
    expect(outcomeOf("DISTRICT_REVIEW", { approve: 1, reject: 1 })).toBe("pending"); // a third officer breaks the tie
    expect(outcomeOf("DISTRICT_REVIEW", { approve: 0, reject: 2 })).toBe("reject");
  });
  it("only large batches go through quality review", () => {
    expect(requiresQualityReview(49)).toBe(false);
    expect(requiresQualityReview(50)).toBe(true);
    expect(nextStatusOnApproval("DISTRICT_REVIEW", false)).toBe("STATE_REVIEW");
    expect(nextStatusOnApproval("DISTRICT_REVIEW", true)).toBe("QUALITY_REVIEW");
    expect(nextStatusOnApproval("QUALITY_REVIEW", true)).toBe("STATE_REVIEW");
    expect(nextStatusOnApproval("STATE_REVIEW", true)).toBe("APPROVED");
  });
});

describe("certificate numbers", () => {
  it("round-trip, and any tampering is detected without a database lookup", () => {
    const n = makeCertificateNumber(100245, 2026);
    expect(n).toMatch(/^CF-2026-100245-[A-Z2-9]{4}$/);
    expect(hasValidCheckCode(n)).toBe(true);
    expect(hasValidCheckCode(n.replace("100245", "100246"))).toBe(false);
    expect(hasValidCheckCode("CF-2026-100245-AAAA")).toBe(false);
    expect(hasValidCheckCode("'; DROP TABLE certificates;--")).toBe(false);
  });
});

describe("spreadsheet validation", () => {
  const header = ["enrolment_no", "full_name", "phone", "email", "score"];
  it("normalises Indian phone numbers", () => {
    expect(normalisePhone("98765 43210")).toBe("+919876543210");
    expect(normalisePhone("+91-9876543210")).toBe("+919876543210");
    expect(normalisePhone("0987654321")).toBeNull();
    expect(normalisePhone("12345")).toBeNull();
  });
  it("reports EVERY problem with row and column, not just the first", () => {
    const { errors, rows } = validateGrid([
      header,
      ["E-001", "Asha Rao", "9876543210", "", "80"],
      ["E-002", "=cmd|' /C calc'!A0", "9876543211", "", "80"], // formula injection
      ["E-003", "Ravi Kumar", "12345", "", "80"],
      ["E-004", "Sita Devi", "9876543212", "not-an-email", "80"],
      ["E-005", "Gopal Das", "9876543213", "", "35"], // below pass mark of 40
      ["E-001", "Asha Rao", "9876543214", "", "80"], // duplicate enrolment
      ["E-007", "Omar Ali", "9876543210", "", "abc"], // duplicate phone + bad score
    ], 40);
    const codes = errors.map((e) => `${e.row}:${e.column}:${e.code}`);
    expect(codes).toEqual(expect.arrayContaining([
      "3:full_name:INVALID_NAME", "4:phone:INVALID_PHONE", "5:email:INVALID_EMAIL", "6:score:BELOW_PASS_MARK",
      "7:enrolment_no:DUPLICATE_IN_FILE", "8:phone:DUPLICATE_IN_FILE", "8:score:INVALID_SCORE",
    ]));
    expect(rows.map((r) => r.row)).toEqual([2]); // only the clean row would have been importable
  });
  it("rejects missing columns and empty files clearly", () => {
    expect(validateGrid([["enrolment_no", "full_name"]], 40).errors[0]?.code).toBe("MISSING_COLUMNS");
    expect(validateGrid([], 40).errors[0]?.code).toBe("EMPTY_FILE");
  });
});
