import { ConsoleDomainError } from "./errors";

/**
 * Parses and clamps a console list `limit` query parameter.
 *
 * `undefined` and the empty string both mean "not supplied" and take
 * `fallback`. Any other value must be numeric: a non-numeric one is a caller
 * error, never a silent fallback to the default. The result is always a finite
 * integer in `[1, max]`.
 *
 * One parser because four list endpoints otherwise each spelled out the same
 * `Number()` → finiteness check → clamp, differing only in the default and the
 * cap — which is exactly how a limit silently stops being enforced on one
 * endpoint while the others keep clamping.
 */
export function parseQueryLimit(raw: string | undefined, fallback: number, max: number): number {
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(value)) {
    throw new ConsoleDomainError("invalid_limit", 400, "limit must be a finite number");
  }
  return Math.min(Math.max(Math.floor(value), 1), max);
}
