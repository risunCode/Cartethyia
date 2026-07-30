/**
 * Config helpers — the single numeric validator for env/config parsing.
 *
 * Replaces the previously duplicated `parseBoundedNumber` (config.ts) and
 * `boundedNumber` (console/env.ts). One implementation, one behavior.
 */

export interface NumericBounds {
  fallback: number;
  min: number;
  max: number;
}

/** Parse a raw value into a finite number clamped to [min, max]; non-finite input returns fallback. */
export function validateNumeric(raw: string | number | undefined, bounds: NumericBounds): number {
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(parsed)) return bounds.fallback;
  return Math.min(bounds.max, Math.max(bounds.min, parsed));
}

/**
 * Validate an already-parsed number against an inclusive [min, max] range.
 * Returns an error message when out of range/non-finite, otherwise null.
 * Used by request-body validators that reject rather than clamp.
 */
export function numericRangeError(
  value: number | undefined,
  field: string,
  min: number,
  max: number,
): string | null {
  if (value === undefined) return null;
  if (!Number.isFinite(value) || value < min || value > max) {
    return `${field} must be ${min}\u2013${max}`;
  }
  return null;
}
