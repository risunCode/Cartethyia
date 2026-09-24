// Shared cursor encoding for audit and telemetry pagination.

/**
 * Bound on the decode cache. Cursors are opaque strings; the console re-issues
 * the same cursor on dashboard refetches and client retries, so a small LRU
 * avoids repeating base64 + JSON.parse for the hot pages. Bounded so an
 * attacker-supplied cursor stream cannot grow the cache without limit.
 */
const DECODE_CACHE_MAX = 256;
const decodeCache = new Map<string, unknown>();

export function encodeCursor<T extends object>(row: T): string {
  return Buffer.from(JSON.stringify(row), "utf8").toString("base64url");
}

/**
 * Decodes a cursor, returning `undefined` for a missing or malformed value.
 * Successful decodes are memoized (bounded LRU). The cached value is returned
 * as a shallow copy so one caller mutating its decoded cursor cannot corrupt
 * another caller's view of the same page boundary.
 */
export function decodeCursor<T>(cursor: string | undefined): T | undefined {
  if (!cursor) return undefined;
  const cached = decodeCache.get(cursor);
  if (cached !== undefined) {
    // Refresh LRU position (Map preserves insertion order).
    decodeCache.delete(cursor);
    decodeCache.set(cursor, cached);
    return copyDecoded<T>(cached);
  }
  let parsed: unknown;
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (decodeCache.size >= DECODE_CACHE_MAX) {
    const oldest = decodeCache.keys().next().value;
    if (oldest !== undefined) decodeCache.delete(oldest);
  }
  decodeCache.set(cursor, parsed);
  return copyDecoded<T>(parsed);
}

function copyDecoded<T>(value: unknown): T {
  if (value !== null && typeof value === "object") return { ...(value as object) } as T;
  return value as T;
}
