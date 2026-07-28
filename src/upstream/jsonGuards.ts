/**
 * Runtime-checked field readers for untyped JSON parsed off the wire (SSE
 * frames, upstream responses). Every reader does a real `typeof`/shape
 * check and returns `undefined` on mismatch instead of trusting an inline
 * `as` cast — a malformed or version-drifted upstream event degrades to
 * "field missing" instead of a silently wrong value.
 */

export function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export function field(obj: Record<string, unknown> | undefined, key: string): unknown {
  return obj?.[key];
}
