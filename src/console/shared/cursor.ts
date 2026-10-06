// Shared cursor encoding for audit and telemetry pagination.

/**
 * Bound on the decode cache. Cursors are opaque strings; the console re-issues
 * the same cursor on dashboard refetches and client retries, so a small LRU
 * avoids repeating base64 + JSON.parse for the hot pages. Bounded so an
 * attacker-supplied cursor stream cannot grow the cache without limit.
 */
const DECODE_CACHE_MAX = 256;
const decodeCache = new Map<string, unknown>();

/**
 * Maximum nesting depth a decoded cursor may have.
 *
 * `JSON.parse` accepts arbitrary nesting (it is iterative in this runtime), but
 * every traversal of the result is not: `deepFreeze` used to recurse once per
 * level, and `structuredClone` recurses again. A payload past the stack limit
 * therefore threw `RangeError: Maximum call stack size exceeded` out of a function
 * that documents returning `undefined` for a malformed value — failing OPEN into a
 * 500 where the contract is "fall back to the first page", and leaving a partially
 * frozen object in the decode cache so a retry of the identical cursor behaved
 * differently from the first attempt.
 *
 * The bound is generous rather than tuned: the only cursors this gateway issues are
 * `{ createdAt, id }` (depth 1) from the audit and telemetry listings. 32 leaves
 * room for a future cursor to nest a small structure while keeping every traversal
 * far below the stack limit.
 */
const MAX_CURSOR_DEPTH = 32;

/** True when `value` nests no deeper than `MAX_CURSOR_DEPTH`. Iterative, so it cannot itself overflow. */
function withinDepthLimit(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  // Breadth-first with an explicit stack: each entry carries its own depth, so no
  // call frame is spent per level.
  const stack: { node: unknown; depth: number }[] = [{ node: value, depth: 1 }];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) break;
    const node = entry.node;
    if (node === null || typeof node !== "object") continue;
    if (entry.depth > MAX_CURSOR_DEPTH) return false;
    for (const child of Object.values(node as Record<string, unknown>)) {
      if (child !== null && typeof child === "object") {
        stack.push({ node: child, depth: entry.depth + 1 });
      }
    }
  }
  return true;
}

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
  // Checked BEFORE the cache write, so a payload that fails the traversal below
  // cannot leave a partially frozen entry behind for a later retry to find.
  if (!withinDepthLimit(parsed)) return undefined;
  if (decodeCache.size >= DECODE_CACHE_MAX) {
    const oldest = decodeCache.keys().next().value;
    if (oldest !== undefined) decodeCache.delete(oldest);
  }
  decodeCache.set(cursor, parsed);
  return copyDecoded<T>(parsed);
}

/**
 * Freezes `value` and every object reachable from it. Iterative rather than
 * recursive: the depth limit above already bounds the input, but a traversal that
 * cannot overflow is one less place for the bound to be forgotten.
 */
function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== "object") continue;
    if (Object.isFrozen(node)) continue;
    Object.freeze(node);
    for (const child of Object.values(node as Record<string, unknown>)) {
      if (child !== null && typeof child === "object") stack.push(child);
    }
  }
}

function copyDecoded<T>(value: unknown): T {
  // Deep-frozen at rest: a caller mutating a nested field must not poison
  // the cached entry for later users of the same cursor string.
  if (value !== null && typeof value === "object") {
    deepFreeze(value);
    try {
      return structuredClone(value) as T;
    } catch {
      // `structuredClone` recurses, so a value past its own budget throws. The
      // depth limit makes this unreachable for anything `decodeCursor` accepts, but
      // the documented contract is `undefined` for a value that cannot be decoded,
      // and a cache hit on an entry written before the limit existed could still
      // reach here.
      return undefined as T;
    }
  }
  return value as T;
}

/** A keyset page boundary: the `(createdAt, id)` pair every listing orders by. */
export interface DatedCursor {
  createdAt: string;
  id: string;
}

/**
 * Decodes a `(createdAt, id)` keyset cursor, rejecting anything malformed.
 *
 * Both the audit log and the telemetry event listing paginate on the same pair
 * and both had written the same validation locally — a shape check plus a
 * parseable timestamp. It lives here so the two listings cannot drift: a cursor
 * the audit store accepts must be one the stats store accepts.
 *
 * Deliberately not generic over `T extends DatedCursor`: a caller could then
 * instantiate it with a wider type and read fields that were never validated.
 */
export function decodeDatedCursor(cursor: string | undefined): DatedCursor | undefined {
  const parsed = decodeCursor<DatedCursor>(cursor);
  if (!parsed || typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") {
    return undefined;
  }
  if (Number.isNaN(new Date(parsed.createdAt).getTime())) return undefined;
  return parsed;
}
