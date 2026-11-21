/** drizzle wraps driver errors ("Failed query: ...") and keeps the original pg error in `.cause`. */
export function pgError(e: unknown): { code?: string; constraint?: string; detail?: string; message?: string } {
  const err = e as { cause?: unknown } & Record<string, unknown>;
  return ((err?.cause as Record<string, unknown>) ?? err) as { code?: string; constraint?: string; detail?: string; message?: string };
}
