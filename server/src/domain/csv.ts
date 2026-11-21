import { parse } from "csv-parse/sync";
import ExcelJS from "exceljs";
import { config } from "../config.js";

export interface RowError { row: number; column: string | null; code: string; message: string }
export interface ParsedRow {
  row: number; // 1-based spreadsheet row number INCLUDING the header (so row 2 = first data row)
  enrolmentNo: string; fullName: string; phone: string; email: string | null; score: number;
}
export interface ParseResult { rows: ParsedRow[]; errors: RowError[] }

const REQUIRED = ["enrolment_no", "full_name", "phone", "score"] as const;
const OPTIONAL = ["email"] as const;
const MAX_ERRORS = 500;

const normHeader = (h: unknown) => String(h ?? "").replace(/^﻿/, "").trim().toLowerCase().replace(/[\s-]+/g, "_");

/** Turn a file (CSV or XLSX) into a grid of strings. */
export async function readGrid(buf: Buffer, filename: string): Promise<string[][]> {
  if (/\.xlsx$/i.test(filename)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) return [];
    const grid: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        const v = cell.value;
        cells[col - 1] = v == null ? "" : typeof v === "object" && "text" in v ? String((v as { text: unknown }).text) : String(v);
      });
      grid[row.number - 1] = Array.from(cells, (c) => c ?? "");
    });
    return Array.from(grid, (r) => r ?? []);
  }
  return parse(buf, { bom: true, relax_column_count: true, skip_empty_lines: true, trim: true }) as string[][];
}

export function normalisePhone(raw: string): string | null {
  const digits = raw.replace(/[\s\-().]/g, "");
  const m = /^(?:\+?91)?([6-9]\d{9})$/.exec(digits);
  return m ? `+91${m[1]}` : null;
}

/**
 * Validates the WHOLE file and returns every problem it finds (up to a cap), with exact row + column.
 * It is pure (no database): cross-batch duplicate checks are added by the caller, inside the transaction.
 * The caller saves nothing unless `errors` is empty -> all-or-nothing import.
 */
export function validateGrid(grid: string[][], passScore: number): ParseResult {
  const errors: RowError[] = [];
  const push = (e: RowError) => { if (errors.length < MAX_ERRORS) errors.push(e); };
  const rows: ParsedRow[] = [];

  if (grid.length === 0) {
    return { rows, errors: [{ row: 1, column: null, code: "EMPTY_FILE", message: "The file is empty" }] };
  }
  const header = grid[0]!.map(normHeader);
  const missing = REQUIRED.filter((c) => !header.includes(c));
  if (missing.length) {
    return {
      rows,
      errors: [{
        row: 1, column: missing.join(","), code: "MISSING_COLUMNS",
        message: `Missing required column(s): ${missing.join(", ")}. Expected header: ${[...REQUIRED, ...OPTIONAL].join(", ")}`,
      }],
    };
  }
  const known = new Set<string>([...REQUIRED, ...OPTIONAL]);
  header.forEach((h, i) => {
    if (!known.has(h)) push({ row: 1, column: h || `column ${i + 1}`, code: "UNKNOWN_COLUMN", message: `Unexpected column "${h}"` });
  });
  const dupHeader = header.find((h, i) => h && header.indexOf(h) !== i);
  if (dupHeader) push({ row: 1, column: dupHeader, code: "DUPLICATE_COLUMN", message: `Column "${dupHeader}" appears twice` });

  const idx = Object.fromEntries([...REQUIRED, ...OPTIONAL].map((c) => [c, header.indexOf(c)])) as Record<string, number>;
  const dataRows = grid.length - 1;
  if (dataRows === 0) push({ row: 2, column: null, code: "NO_ROWS", message: "The file has a header but no candidates" });
  if (dataRows > config.MAX_BATCH_ROWS) {
    push({ row: 1, column: null, code: "TOO_MANY_ROWS", message: `A batch can hold at most ${config.MAX_BATCH_ROWS} candidates (file has ${dataRows})` });
    return { rows, errors };
  }

  const seenEnrol = new Map<string, number>();
  const seenPhone = new Map<string, number>();

  for (let i = 1; i < grid.length; i++) {
    const line = grid[i]!;
    const rowNo = i + 1;
    const cell = (c: string) => (idx[c]! >= 0 ? (line[idx[c]!] ?? "").trim() : "");
    const before = errors.length;

    if (line.length > header.length) push({ row: rowNo, column: null, code: "TOO_MANY_CELLS", message: `Row has ${line.length} cells but the header has ${header.length}` });

    const enrolmentNo = cell("enrolment_no");
    if (!enrolmentNo) push({ row: rowNo, column: "enrolment_no", code: "REQUIRED", message: "Enrolment number is required" });
    else if (!/^[A-Za-z0-9][A-Za-z0-9\-/]{2,29}$/.test(enrolmentNo)) push({ row: rowNo, column: "enrolment_no", code: "INVALID_ENROLMENT_NO", message: `"${enrolmentNo}" is not a valid enrolment number (3-30 letters, digits, - or /)` });
    else if (seenEnrol.has(enrolmentNo)) push({ row: rowNo, column: "enrolment_no", code: "DUPLICATE_IN_FILE", message: `Enrolment number ${enrolmentNo} already appears on row ${seenEnrol.get(enrolmentNo)}` });
    else seenEnrol.set(enrolmentNo, rowNo);

    // Letters/marks/space . ' - only. This also rules out spreadsheet formula injection (=, +, -, @ at the start).
    const fullName = cell("full_name").replace(/\s+/g, " ");
    if (!fullName) push({ row: rowNo, column: "full_name", code: "REQUIRED", message: "Full name is required" });
    else if (fullName.length < 2 || fullName.length > 100 || !/^[\p{L}\p{M}][\p{L}\p{M} .'\-]*$/u.test(fullName))
      push({ row: rowNo, column: "full_name", code: "INVALID_NAME", message: `"${fullName.slice(0, 40)}" is not a valid name (letters, spaces, . ' - only)` });

    const rawPhone = cell("phone");
    let phone = "";
    if (!rawPhone) push({ row: rowNo, column: "phone", code: "REQUIRED", message: "Phone number is required" });
    else {
      const p = normalisePhone(rawPhone);
      if (!p) push({ row: rowNo, column: "phone", code: "INVALID_PHONE", message: `"${rawPhone}" is not a valid Indian mobile number` });
      else if (seenPhone.has(p)) push({ row: rowNo, column: "phone", code: "DUPLICATE_IN_FILE", message: `Phone ${p} already appears on row ${seenPhone.get(p)}` });
      else { phone = p; seenPhone.set(p, rowNo); }
    }

    const emailRaw = cell("email");
    let email: string | null = null;
    if (emailRaw) {
      if (emailRaw.length > 120 || !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(emailRaw) || /^[=+\-@]/.test(emailRaw))
        push({ row: rowNo, column: "email", code: "INVALID_EMAIL", message: `"${emailRaw.slice(0, 40)}" is not a valid email` });
      else email = emailRaw.toLowerCase();
    }

    const scoreRaw = cell("score");
    let score = -1;
    if (scoreRaw === "") push({ row: rowNo, column: "score", code: "REQUIRED", message: "Score is required" });
    else if (!/^\d{1,3}$/.test(scoreRaw) || Number(scoreRaw) > 100) push({ row: rowNo, column: "score", code: "INVALID_SCORE", message: `"${scoreRaw}" is not a whole number between 0 and 100` });
    else {
      score = Number(scoreRaw);
      if (score < passScore) push({ row: rowNo, column: "score", code: "BELOW_PASS_MARK", message: `Score ${score} is below the pass mark of ${passScore}; only passed candidates can be certified` });
    }

    if (errors.length === before) rows.push({ row: rowNo, enrolmentNo, fullName, phone, email, score });
  }
  return { rows, errors };
}
