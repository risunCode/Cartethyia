/** Shared runtime guards for closed string-value sets. */

/** Narrow an unknown input to one of a typed, immutable list of string literals. */
export function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}
