/**
 * Number guards — canonical numeric coercion for runtime data (usage rows,
 * extracted upstream token counts, JSON fields).
 *
 * Replaces the previously duplicated `nullableNumber` / `num` (returns
 * number|null for finite input) and `numberOrZero` (null-coalesce to 0).
 */

/** Return the value only when it is a finite number, otherwise null. */
export function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Coalesce a nullable number to 0. */
export function orZero(value: number | null | undefined): number {
  return value ?? 0;
}
