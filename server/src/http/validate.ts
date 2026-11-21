import { z, ZodError, type ZodType } from "zod";
import { AppError } from "./errors.js";

/** Parse + validate untrusted input. Unknown keys are stripped, wrong types/lengths become a 400 with details. */
export function parse<T extends ZodType>(schema: T, data: unknown): z.infer<T> {
  try {
    return schema.parse(data);
  } catch (e) {
    if (e instanceof ZodError) throw new AppError(400, "VALIDATION_FAILED", "Invalid input", e.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    throw e;
  }
}
export const uuid = z.string().uuid();
