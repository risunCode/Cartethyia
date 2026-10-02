/**
 * Cursor encoding and decoding, as units.
 *
 * `src/persistence/page-cursor.ts` owns the opaque `(createdAt, id)` page
 * boundary for both console listings — the audit log and the telemetry event
 * stream. A cursor is caller-supplied, arrives in a query string, and is handed
 * straight to `new Date(cursor.createdAt)` inside a SQL keyset comparison, so
 * the only safe failure mode is `undefined`.
 *
 * Two properties are load-bearing:
 *
 * - **Fail closed.** Anything that is not a well-formed `(createdAt, id)` pair
 *   decodes to `undefined`, so the listing falls back to its first page rather
 *   than to a boundary the caller chose. A cursor that throws instead escapes
 *   the decoder's contract.
 * - **One cursor, one page boundary.** Decoded values are memoized, so the
 *   value handed to a caller must be a copy: a caller mutating its cursor must
 *   not move the boundary for every later user of the same string.
 *
 * The audit and stats stores each had their own copy of this validation before
 * it was consolidated here, which is why the shape rules are pinned tightly:
 * the consolidation only holds if both listings accept and reject the same set.
 */
import { describe, expect, test } from "bun:test";
import type { DatedCursor } from "../../src/persistence/page-cursor";
import {
  decodeCursor,
  decodeDatedCursor,
  encodeCursor,
} from "../../src/persistence/page-cursor";

/** Builds a cursor from raw JSON the way a caller with a hand-made string would. */
function cursorOf(payload: string): string {
  return Buffer.from(payload, "utf8").toString("base64url");
}

const VALID: DatedCursor = { createdAt: "2024-01-01T00:00:00.000Z", id: "audit-1" };

describe("encodeCursor", () => {
  test("emits unpadded base64url of the row's JSON", () => {
    // The exact spelling matters: this string travels in a query string, so
    // `+`, `/` and `=` would need escaping and invite a re-encoding bug.
    const encoded = encodeCursor(VALID);
    expect(encoded).toBe(
      Buffer.from(JSON.stringify(VALID), "utf8").toString("base64url"),
    );
    expect(encoded).not.toMatch(/[+/=]/);
  });

  test("stays url-safe for ids whose standard base64 would need escaping", () => {
    // `id-0~ÿ` is chosen because its standard base64 contains `+` and `=`.
    const encoded = encodeCursor({ createdAt: VALID.createdAt, id: "id-0~ÿ" });
    expect(encoded).not.toMatch(/[+/=]/);
    expect(encoded).not.toBe(
      Buffer.from(JSON.stringify({ createdAt: VALID.createdAt, id: "id-0~ÿ" }), "utf8").toString("base64"),
    );
  });

  test("does not throw on a lone surrogate and round-trips it exactly", () => {
    // A row id is database text, but `JSON.stringify` is what turns it into
    // bytes; an unpaired surrogate must be escaped rather than crash the
    // encoder or be silently replaced.
    const id = "lone\ud800surrogate";
    const encoded = encodeCursor({ createdAt: VALID.createdAt, id });
    expect(decodeDatedCursor(encoded)?.id).toBe(id);
  });
});

describe("decodeCursor: round trip", () => {
  test("returns the original fields", () => {
    expect(decodeCursor<DatedCursor>(encodeCursor(VALID))).toEqual(VALID);
  });

  test("preserves field order and additional fields", () => {
    // The encoder is generic over `T extends object`, and callers may add
    // fields; decoding must not reshape the row.
    const row = { createdAt: VALID.createdAt, id: "a", z: 1, a: 2, nested: { b: [1, 2, 3] } };
    expect(decodeCursor<typeof row>(encodeCursor(row))).toEqual(row);
    expect(Object.keys(decodeCursor<typeof row>(encodeCursor(row)) ?? {})).toEqual([
      "createdAt",
      "id",
      "z",
      "a",
      "nested",
    ]);
  });

  test("preserves unicode and characters with JSON or URL meaning", () => {
    // These are the ids most likely to be mangled by a double-encode or a
    // percent-decode somewhere between the store and the query string.
    const ids = [
      "🔒 lock",
      "café",
      "emoji👨‍👩‍👧‍👦zwj",
      "  padded  ",
      "comma,separated",
      "tab\there",
      "line\nbreak",
      'quote"double',
      "back\\slash",
      "semi;colon",
      "amp&ersand",
      "eq=sign",
      "hash#tag",
      "percent%20",
      "plus+sign",
      "slash/slash",
      "question?mark",
      "nul\u0000byte",
    ];
    for (const id of ids) {
      const decoded = decodeDatedCursor(encodeCursor({ createdAt: VALID.createdAt, id }));
      expect(decoded?.id).toBe(id);
    }
  });
});

describe("decodeCursor: malformed input fails closed", () => {
  test("returns undefined for missing and empty input", () => {
    // `!cursor` catches both, which is the difference between "no cursor" and
    // "a cursor that is the empty string".
    expect(decodeCursor(undefined)).toBeUndefined();
    expect(decodeCursor("")).toBeUndefined();
  });

  test("returns undefined for values that are not base64 at all", () => {
    for (const value of ["!!!!not base64!!!!", "   ", "\n", "null", "42", "-"]) {
      expect(decodeCursor(value)).toBeUndefined();
    }
  });

  test("returns undefined for a truncated JSON payload", () => {
    expect(decodeCursor(cursorOf('{"createdAt":"2024-01-01T00:00:00.000Z"'))).toBeUndefined();
    expect(decodeCursor(cursorOf('{"createdAt":'))).toBeUndefined();
  });

  test("returns undefined for bytes that are not valid UTF-8 text", () => {
    expect(decodeCursor(Buffer.from([0xff, 0xfe]).toString("base64url"))).toBeUndefined();
  });

  test("accepts standard base64 and padded input as well as base64url", () => {
    // Pinned as observed leniency: `Buffer.from(x, "base64url")` also decodes
    // the standard alphabet and padding. It is not a correctness problem — the
    // result still has to parse and validate — but it means a cursor that was
    // URL-escaped by an intermediate layer still works.
    const payload = JSON.stringify(VALID);
    expect(decodeDatedCursor(Buffer.from(payload, "utf8").toString("base64"))).toEqual(VALID);
    expect(decodeDatedCursor(`${Buffer.from(payload, "utf8").toString("base64url")}==`)).toEqual(VALID);
    expect(decodeDatedCursor(`${Buffer.from(payload, "utf8").toString("base64url")}\n`)).toEqual(VALID);
  });

  test("returns the parsed JSON for a non-object payload, without validating it", () => {
    // `decodeCursor` is the raw JSON layer: it only fails closed on input that
    // does not parse. Shape validation is `decodeDatedCursor`'s job, which is
    // why every one of these is rejected there instead.
    expect(decodeCursor<number>(cursorOf("42"))).toBe(42);
    expect(decodeCursor<string>(cursorOf('"hello"'))).toBe("hello");
    expect(decodeCursor<boolean>(cursorOf("true"))).toBe(true);
    expect(decodeCursor<unknown[]>(cursorOf("[1,2]"))).toEqual([1, 2]);
  });

  test("returns null for a literal JSON null rather than undefined", () => {
    // Documented divergence from the declared `T | undefined` return type: a
    // valid `null` payload is neither missing nor malformed, so it is returned
    // as `null`. `decodeDatedCursor`'s `!parsed` guard is what makes this safe
    // for the two real consumers; a new caller checking `=== undefined` would
    // not be.
    expect(decodeCursor<null>(cursorOf("null"))).toBeNull();
  });

  test("never lets a caller-supplied payload reach the prototype", () => {
    // The payload is attacker-controlled. `JSON.parse` defines `__proto__` as a
    // plain own property, so this must not become prototype pollution for the
    // process the cursor was decoded in.
    const decoded = decodeCursor<Record<string, unknown>>(
      cursorOf('{"createdAt":"2024-01-01T00:00:00.000Z","id":"a","__proto__":{"polluted":true}}'),
    );
    expect(decoded?.["__proto__"]).toEqual({ polluted: true });
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});

describe("decodeCursor: memoization is invisible to callers", () => {
  test("returns an equal but distinct object on a cache hit", () => {
    // The second call takes the cache path. Callers must not be able to tell,
    // or one of them will start aliasing another's page boundary.
    const encoded = encodeCursor(VALID);
    const first = decodeCursor<DatedCursor>(encoded);
    const second = decodeCursor<DatedCursor>(encoded);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  test("a nested mutation does not poison the cached entry", () => {
    // This is the reason the copy is deep. A shallow copy would let a caller
    // rewriting `meta` move the boundary for everyone who reuses the string.
    const row = { createdAt: VALID.createdAt, id: "a", meta: { note: "original" } };
    const encoded = encodeCursor(row);
    const first = decodeCursor<typeof row>(encoded);
    if (!first) throw new Error("expected a decoded cursor");
    first.meta.note = "mutated";
    expect(decodeCursor<typeof row>(encoded)?.meta.note).toBe("original");
  });

  test("a mutation of a decoded dated cursor does not poison the cache", () => {
    const encoded = encodeCursor(VALID);
    const first = decodeDatedCursor(encoded);
    if (!first) throw new Error("expected a decoded cursor");
    first.id = "mutated";
    expect(decodeDatedCursor(encoded)?.id).toBe(VALID.id);
  });

  test("still decodes correctly after the cache bound is exceeded", () => {
    // `DECODE_CACHE_MAX` is 256. The bound must only cost a re-parse, never a
    // wrong answer: an evicted cursor has to decode exactly like a fresh one.
    const encoded = Array.from({ length: 300 }, (_, index) =>
      encodeCursor({ createdAt: VALID.createdAt, id: `id-${index}` }),
    );
    for (const [index, cursor] of encoded.entries()) {
      expect(decodeDatedCursor(cursor)?.id).toBe(`id-${index}`);
    }
    // The oldest entries were evicted long ago; they must still round-trip.
    expect(decodeDatedCursor(encoded[0] ?? "")?.id).toBe("id-0");
    expect(decodeDatedCursor(encoded[299] ?? "")?.id).toBe("id-299");
  });

  test("does not cache by decoded content, only by the exact string", () => {
    // Two spellings of the same payload are two cache entries but one result;
    // equality of the decoded value is what callers depend on.
    const payload = JSON.stringify(VALID);
    const urlSafe = Buffer.from(payload, "utf8").toString("base64url");
    const standard = Buffer.from(payload, "utf8").toString("base64");
    expect(urlSafe).not.toBe(standard);
    expect(decodeDatedCursor(standard)).toEqual(decodeDatedCursor(urlSafe));
  });
});

describe("decodeDatedCursor: shape validation", () => {
  test("returns the pair for a well-formed cursor", () => {
    expect(decodeDatedCursor(encodeCursor(VALID))).toEqual(VALID);
  });

  test("returns undefined for missing input", () => {
    expect(decodeDatedCursor(undefined)).toBeUndefined();
    expect(decodeDatedCursor("")).toBeUndefined();
  });

  test("rejects a payload that is not an object", () => {
    // `typeof null === "object"`, so the `!parsed` guard is what rejects null.
    // An array passes `typeof` but has no `createdAt`/`id`, so the field checks
    // catch it.
    for (const payload of ["null", "42", '"a"', "true", "[1,2]", '[{"createdAt":"2024-01-01","id":"a"}]']) {
      expect(decodeDatedCursor(cursorOf(payload))).toBeUndefined();
    }
  });

  test("requires both fields to be present strings", () => {
    expect(decodeDatedCursor(cursorOf('{"createdAt":"2024-01-01T00:00:00.000Z"}'))).toBeUndefined();
    expect(decodeDatedCursor(cursorOf('{"id":"a"}'))).toBeUndefined();
    expect(decodeDatedCursor(cursorOf('{"createdAt":"2024-01-01T00:00:00.000Z","id":7}'))).toBeUndefined();
    expect(decodeDatedCursor(cursorOf('{"createdAt":"2024-01-01T00:00:00.000Z","id":null}'))).toBeUndefined();
    expect(decodeDatedCursor(cursorOf('{"createdAt":"2024-01-01T00:00:00.000Z","id":{}}'))).toBeUndefined();
    expect(decodeDatedCursor(cursorOf('{"createdAt":"2024-01-01T00:00:00.000Z","id":["a"]}'))).toBeUndefined();
    expect(decodeDatedCursor(cursorOf('{"createdAt":1704067200000,"id":"a"}'))).toBeUndefined();
    expect(decodeDatedCursor(cursorOf('{"createdAt":null,"id":"a"}'))).toBeUndefined();
  });

  test("rejects a createdAt that is not a parseable date", () => {
    // This string is passed to `new Date(...)` and compared against a timestamp
    // column, so an unparseable value must never reach the query.
    expect(decodeDatedCursor(cursorOf('{"createdAt":"nonsense","id":"a"}'))).toBeUndefined();
    expect(decodeDatedCursor(cursorOf('{"createdAt":"2024-13-01","id":"a"}'))).toBeUndefined();
    // An empty string is the one that would silently become the epoch.
    expect(decodeDatedCursor(cursorOf('{"createdAt":"","id":"a"}'))).toBeUndefined();
  });

  test("keeps additional fields on the returned object", () => {
    // Observed and pinned: the validator checks two fields but returns the
    // whole parsed object, so an unknown field survives decoding even though
    // the declared return type says `DatedCursor`. The store reads only
    // `createdAt` and `id`, which is why this is harmless today — and why a
    // caller must not treat the returned object as fully validated.
    const decoded = decodeDatedCursor(
      cursorOf('{"createdAt":"2024-01-01T00:00:00.000Z","id":"a","extra":1}'),
    );
    expect(decoded?.createdAt).toBe("2024-01-01T00:00:00.000Z");
    expect(decoded?.id).toBe("a");
    expect(Object.keys(decoded ?? {}).sort()).toEqual(["createdAt", "extra", "id"]);
  });

  test("accepts an empty id string", () => {
    // Pinned because it is the loosest thing the validator allows: an empty id
    // is a valid string, and the keyset comparison `(createdAt, id) < (...)` is
    // still well-defined against it.
    expect(decodeDatedCursor(cursorOf('{"createdAt":"2024-01-01T00:00:00.000Z","id":""}'))?.id).toBe("");
  });
});

describe("decodeDatedCursor: date parsing is lenient", () => {
  test("accepts dates the platform rolls over instead of rejecting", () => {
    // `new Date("2024-02-30")` is March 1 rather than an invalid date, so a
    // rolled-over boundary is accepted. It is not a security problem — the
    // value only moves a page boundary — but it is a real leniency, and it is
    // why the store cannot treat a decoded cursor as a canonical timestamp.
    const rolled = decodeDatedCursor(cursorOf('{"createdAt":"2024-02-30","id":"a"}'));
    expect(rolled?.createdAt).toBe("2024-02-30");
    expect(new Date(rolled?.createdAt ?? "").getTime()).toBe(new Date("2024-03-01T00:00:00.000Z").getTime());
    expect(Number.isNaN(new Date(rolled?.createdAt ?? "").getTime())).toBe(false);
  });

  test("accepts partial and epoch-relative date strings", () => {
    for (const createdAt of ["2024", "0", "2024-01-01", "Sat, 01 Jan 2024 00:00:00 GMT"]) {
      expect(decodeDatedCursor(cursorOf(JSON.stringify({ createdAt, id: "a" })))).toEqual({ createdAt, id: "a" });
    }
  });

  test("rejects a date that the platform cannot parse at all", () => {
    for (const createdAt of ["nonsense", "", "2024-13-01", "2024-02-30T99:99:99.999Z"]) {
      expect(decodeDatedCursor(cursorOf(JSON.stringify({ createdAt, id: "a" })))).toBeUndefined();
    }
  });
});

describe("decodeCursor: input the module does not bound", () => {
  test("round-trips a very large id", () => {
    // There is no size limit on a cursor, so the cost of a decode is the cost
    // of its payload. Pinned so the absence of a bound is a known property.
    const id = "x".repeat(200_000);
    const decoded = decodeDatedCursor(encodeCursor({ createdAt: VALID.createdAt, id }));
    expect(decoded?.id).toHaveLength(200_000);
  });

  test("decodes a payload at the depth limit and refuses one past it", () => {
    // Depth is now bounded. The limit exists because every traversal of the parsed
    // value (`deepFreeze`, `structuredClone`) recurses, so a payload past the stack
    // limit used to throw out of a function that documents returning `undefined`.
    // The bound is generous: the only cursors this gateway issues are
    // `{ createdAt, id }`, depth 1.
    const atLimit = cursorOf(`${"[".repeat(31)}1${"]".repeat(31)}`);
    expect(decodeCursor(atLimit)).toBeDefined();

    const pastLimit = cursorOf(`${"[".repeat(33)}1${"]".repeat(33)}`);
    expect(decodeCursor(pastLimit)).toBeUndefined();
  });

  test("a deeply nested payload decodes to undefined instead of throwing", () => {
    // DEFECT: `decodeCursor` documents "returning `undefined` for a missing or
    // malformed value", but a payload nested beyond the stack limit throws
    // `RangeError: Maximum call stack size exceeded` out of the module instead.
    //
    // Mechanism: `JSON.parse` accepts arbitrary nesting depth (it is iterative
    // in this runtime — verified at 200,000 levels), and nothing between the
    // caller and the recursion bounds it. `copyDecoded` then calls `deepFreeze`,
    // which recurses once per level, and `structuredClone`, which recurses
    // again. The throw therefore comes from `deepFreeze`, after `JSON.parse`
    // has already succeeded, and it is not caught: the `try` block covers only
    // the parse.
    //
    // Reachable impact: the decoder fails open into a `RangeError` rather than
    // closed into `undefined`. Both console callers (`DrizzleAuditReadStore.list`
    // and `DrizzleTelemetryEventStore.listEvents`) are inside a route-level
    // try/catch, so the observable result is a 500 where the documented contract
    // is "fall back to the first page" — not a process crash. The same call
    // also leaves a *partially* frozen object in the decode cache, so a retry of
    // the identical cursor succeeds while the first attempt failed, which is an
    // inconsistency in its own right.
    //
    // Not reachable through the current HTTP surface: a cursor arrives only as
    // the `cursor` query parameter, and Bun rejects a request target over
    // roughly 16 KB with a 431 before routing, which caps a decoded payload at
    // about 12 KB — far below the ~26,000 nesting levels needed to overflow.
    // This is therefore a contract violation at the module boundary rather than
    // a live denial of service. It becomes live for any caller that does not go
    // through a URL (a script, a job, a future route reading a cursor from a
    // body) or if the request-target limit is raised.
    const depth = 200_000;
    const payload = cursorOf(`${"[".repeat(depth)}1${"]".repeat(depth)}`);
    expect(decodeCursor(payload)).toBeUndefined();
  });

  test("a deeply nested object payload decodes to undefined instead of throwing", () => {
    // Same defect as above, reached through the object path rather than the
    // array path, and through `decodeDatedCursor` — the function both listings
    // actually call. The two recursion sites (`deepFreeze` and
    // `structuredClone`) have slightly different depth budgets, so this shape is
    // pinned separately rather than assumed to behave like the array one.
    let payload = '"leaf"';
    for (let level = 0; level < 200_000; level += 1) payload = `{"n":${payload}}`;
    const cursor = cursorOf(`{"createdAt":"2024-01-01T00:00:00.000Z","id":"a","deep":${payload}}`);
    expect(decodeDatedCursor(cursor)).toBeUndefined();
  });
});
