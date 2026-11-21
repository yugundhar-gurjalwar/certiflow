import { createHmac } from "node:crypto";
import { config } from "../config.js";

/**
 * Certificate numbers look like  CF-2026-100245-K7QM
 *   - the middle part comes from a database sequence (uniqueness),
 *   - the last 4 characters are an HMAC check code, so numbers cannot be guessed/enumerated and a
 *     mistyped number is rejected without touching the database.
 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I confusion

function checkCode(year: number, seq: number | string): string {
  const mac = createHmac("sha256", config.CERT_NUMBER_SECRET).update(`${year}-${seq}`).digest();
  let out = "";
  for (let i = 0; i < 4; i++) out += ALPHABET[mac[i]! % ALPHABET.length];
  return out;
}

export function makeCertificateNumber(seq: number | string, year = new Date().getUTCFullYear()): string {
  return `CF-${year}-${seq}-${checkCode(year, seq)}`;
}

const SHAPE = /^CF-(\d{4})-(\d{4,12})-([A-Z2-9]{4})$/;
export function hasValidCheckCode(input: string): boolean {
  const m = SHAPE.exec(input);
  if (!m) return false;
  return checkCode(Number(m[1]), m[2]!) === m[3];
}
