/**
 * Pool selection's local state and its byte accounting.
 *
 * Two modules that sit on the hot path of every proxied request and that
 * nothing else in the suite touches:
 *
 * - `pool-state.ts` holds the per-process inflight counters, the provider
 *   cooldowns mirrored out of Redis, and the round-robin cursors. The rotation
 *   maths is the subtle part: the cursor advances by exactly **one position**
 *   after a pool has served `rotateCount` requests, and the module comment
 *   records why — striding by `rotateCount` skips pools whenever the pool count
 *   and `rotateCount` share a factor (2 pools with `rotateCount` 2 pinned one
 *   pool forever). That case is pinned below as a sequence, not a formula.
 * - `byte-accounting.ts` sums the *wire* bytes a pool's proxy carries, because
 *   a `TLSSocket`'s own counters report decrypted plaintext. It is the number
 *   the dashboard shows and the one a proxy provider bills against, so the
 *   direction split (sent vs received) and the string-vs-buffer encoding rules
 *   are worth pinning exactly.
 *
 * Everything here is a pure function of a map or a fake socket: no Redis, no
 * TCP, no timers. The two `MAX_*` sweeps build real maps at the real bound
 * because the bound is the behaviour.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  accountSocketBytes,
  accountSocketWrites,
  MAX_BYTE_ENTRY_COUNT,
  poolByteSnapshot,
  poolByteTotals,
  recordPoolBytes,
  resetPoolByteAccounting,
} from "../../src/network/pool/byte-accounting";
import {
  advanceRotation,
  createPoolLocalState,
  enforceCooldownLimit,
  enforceInflightLimit,
  MAX_COOLDOWN_ENTRIES,
  MAX_INFLIGHT_ENTRIES,
  MAX_ROTATION_KEYS,
  parseCooldownEntry,
  rotationStart,
  type ProxyCooldownEntry,
} from "../../src/network/pool/pool-state";

beforeEach(() => {
  resetPoolByteAccounting();
});

/** A cooldown entry with every field present, so a test only names what it varies. */
function cooldown(overrides: Partial<ProxyCooldownEntry> = {}): ProxyCooldownEntry {
  return {
    poolId: "pool-1",
    providerId: "provider-a",
    until: 1_000,
    reason: "rate limited",
    ...overrides,
  };
}

/** A `write`-carrying stand-in for a raw socket; records what reached the original. */
class FakeWriteSocket {
  readonly written: unknown[][] = [];
  write(...args: unknown[]): boolean {
    this.written.push(args);
    return true;
  }
}

/** An `on`-carrying stand-in; `emit` fans out to whatever the module attached. */
class FakeReadSocket {
  private readonly listeners: Array<(chunk: unknown) => void> = [];
  on(_event: string, listener: (chunk: unknown) => void): this {
    this.listeners.push(listener);
    return this;
  }
  emit(chunk: unknown): void {
    for (const listener of this.listeners) listener(chunk);
  }
}

describe("pool byte accounting: totals", () => {
  test("an unknown pool reads as zeroes rather than undefined", () => {
    expect(poolByteTotals("never-seen")).toEqual({ sent: 0, received: 0 });
  });

  test("the two directions are tracked independently", () => {
    recordPoolBytes("pool-1", "sent", 10);
    recordPoolBytes("pool-1", "received", 25);
    expect(poolByteTotals("pool-1")).toEqual({ sent: 10, received: 25 });
  });

  test("chunks accumulate across calls", () => {
    for (const chunk of [16, 32, 64]) recordPoolBytes("pool-1", "received", chunk);
    expect(poolByteTotals("pool-1").received).toBe(112);
  });

  test("pools do not share a counter", () => {
    recordPoolBytes("pool-1", "sent", 10);
    recordPoolBytes("pool-2", "sent", 20);
    expect(poolByteTotals("pool-1").sent).toBe(10);
    expect(poolByteTotals("pool-2").sent).toBe(20);
  });

  test("zero and negative chunks are dropped and create no entry", () => {
    recordPoolBytes("pool-1", "sent", 0);
    recordPoolBytes("pool-1", "sent", -1);
    expect(poolByteTotals("pool-1")).toEqual({ sent: 0, received: 0 });
    expect(poolByteSnapshot()).toHaveLength(0);
  });

  test("a fractional chunk is added verbatim, not rounded", () => {
    // Unreachable from either socket wrapper (both pass an integer `.length` or
    // `Buffer.byteLength`), but the guard is `bytes <= 0`, so a fractional value
    // is admitted. Pinned so a future tightening is a deliberate change.
    recordPoolBytes("pool-1", "sent", 1.5);
    expect(poolByteTotals("pool-1").sent).toBe(1.5);
  });

  test("a non-finite chunk is admitted and poisons the running total", () => {
    // Documented boundary, measured rather than assumed: `NaN <= 0` and
    // `Infinity <= 0` are both false, so the guard does not stop either, and
    // one such value makes the pool's figure permanently unreadable — every
    // later addition stays NaN. Not reachable from `accountSocketBytes`
    // (it requires `typeof length === "number"`, and a real chunk's length is
    // an integer) or from `accountSocketWrites` (same, plus
    // `Buffer.byteLength`). Left as-is because no production path can supply
    // one; recorded here so the gap is visible rather than silent.
    recordPoolBytes("pool-1", "sent", 5);
    recordPoolBytes("pool-1", "sent", Number.NaN);
    expect(Number.isNaN(poolByteTotals("pool-1").sent)).toBe(true);
  });

  test("the snapshot lists every pool that has carried traffic", () => {
    recordPoolBytes("pool-b", "sent", 2);
    recordPoolBytes("pool-a", "received", 3);
    expect(poolByteSnapshot()).toEqual([
      { poolId: "pool-b", sent: 2, received: 0 },
      { poolId: "pool-a", sent: 0, received: 3 },
    ]);
  });

  test("the snapshot is empty after a reset, and totals fall back to zeroes", () => {
    recordPoolBytes("pool-1", "sent", 7);
    resetPoolByteAccounting();
    expect(poolByteSnapshot()).toHaveLength(0);
    expect(poolByteTotals("pool-1")).toEqual({ sent: 0, received: 0 });
  });

  test("the entry bound is 10,000 pools", () => {
    expect(MAX_BYTE_ENTRY_COUNT).toBe(10_000);
  });

  test("a pool added at the bound evicts the oldest-inserted entry", () => {
    for (let index = 0; index < MAX_BYTE_ENTRY_COUNT; index += 1) {
      recordPoolBytes(`pool-${index}`, "sent", 1);
    }
    expect(poolByteSnapshot()).toHaveLength(MAX_BYTE_ENTRY_COUNT);

    recordPoolBytes("pool-overflow", "sent", 1);
    expect(poolByteSnapshot()).toHaveLength(MAX_BYTE_ENTRY_COUNT);
    expect(poolByteTotals("pool-0").sent).toBe(0);
    expect(poolByteTotals("pool-overflow").sent).toBe(1);
  });

  test("adding to an already-tracked pool never evicts, even at the bound", () => {
    for (let index = 0; index < MAX_BYTE_ENTRY_COUNT; index += 1) {
      recordPoolBytes(`pool-${index}`, "sent", 1);
    }
    // `entry()` returns the existing record before the bound is consulted, so a
    // busy deployment cannot evict its own hot pools by counting.
    recordPoolBytes("pool-0", "sent", 1);
    expect(poolByteSnapshot()).toHaveLength(MAX_BYTE_ENTRY_COUNT);
    expect(poolByteTotals("pool-0").sent).toBe(2);
  });
});

describe("pool byte accounting: the socket wrappers", () => {
  test("a buffer write counts its byte length", () => {
    const socket = accountSocketWrites(new FakeWriteSocket(), "pool-1");
    (socket as unknown as FakeWriteSocket).write(Buffer.from("hello"));
    expect(poolByteTotals("pool-1").sent).toBe(5);
  });

  test("a string write counts bytes, not characters", () => {
    // "héllo" is 5 characters and 6 UTF-8 bytes; the wire figure is the one a
    // provider bills, so it must be 6.
    const socket = accountSocketWrites(new FakeWriteSocket(), "pool-1");
    (socket as unknown as FakeWriteSocket).write("héllo");
    expect(poolByteTotals("pool-1").sent).toBe(6);
  });

  test("an explicit encoding argument is honored", () => {
    const socket = accountSocketWrites(new FakeWriteSocket(), "pool-1");
    (socket as unknown as FakeWriteSocket).write("héllo", "latin1");
    expect(poolByteTotals("pool-1").sent).toBe(5);
  });

  test("a non-string second argument falls back to utf8 rather than being read as an encoding", () => {
    // Node's `write(chunk, callback)` form: arg 1 is the callback, not an
    // encoding. Treating it as one would be wrong; falling back to the utf8
    // default is right.
    const socket = accountSocketWrites(new FakeWriteSocket(), "pool-1");
    (socket as unknown as FakeWriteSocket).write("abc", () => {});
    expect(poolByteTotals("pool-1").sent).toBe(3);
  });

  test("an unrecognized encoding does not throw and falls back to utf8", () => {
    const socket = accountSocketWrites(new FakeWriteSocket(), "pool-1");
    expect(() =>
      (socket as unknown as FakeWriteSocket).write("abc", "definitely-not-an-encoding"),
    ).not.toThrow();
    expect(poolByteTotals("pool-1").sent).toBe(3);
  });

  test("a write with no countable payload is skipped and creates no entry", () => {
    const socket = accountSocketWrites(new FakeWriteSocket(), "pool-1") as unknown as FakeWriteSocket;
    socket.write(null);
    socket.write(undefined);
    socket.write({});
    socket.write({ length: "9" });
    expect(poolByteSnapshot()).toHaveLength(0);
  });

  test("the wrapper forwards every argument and returns the original result", () => {
    const inner = new FakeWriteSocket();
    const socket = accountSocketWrites(inner, "pool-1") as unknown as FakeWriteSocket;
    const result = socket.write("abc", "utf8", () => {});
    expect(result).toBe(true);
    expect(inner.written).toHaveLength(1);
    expect(inner.written[0]?.[0]).toBe("abc");
    expect(inner.written[0]?.[1]).toBe("utf8");
    expect(typeof inner.written[0]?.[2]).toBe("function");
  });

  test("successive writes accumulate on one socket", () => {
    const socket = accountSocketWrites(new FakeWriteSocket(), "pool-1") as unknown as FakeWriteSocket;
    socket.write("abc");
    socket.write(Buffer.from("de"));
    expect(poolByteTotals("pool-1").sent).toBe(5);
  });

  test("a read listener counts incoming chunk length as received", () => {
    const socket = accountSocketBytes(new FakeReadSocket(), "pool-1") as unknown as FakeReadSocket;
    socket.emit(Buffer.from("abcd"));
    expect(poolByteTotals("pool-1")).toEqual({ sent: 0, received: 4 });
  });

  test("a read listener ignores chunks with no numeric length", () => {
    const socket = accountSocketBytes(new FakeReadSocket(), "pool-1") as unknown as FakeReadSocket;
    socket.emit(null);
    socket.emit(undefined);
    socket.emit({});
    socket.emit({ length: "9" });
    expect(poolByteSnapshot()).toHaveLength(0);
  });

  test("a string chunk on the read path counts characters, not bytes", () => {
    // Measured asymmetry with the write path, which uses `Buffer.byteLength`.
    // Harmless in production — a raw socket emits Buffers, never strings — and
    // pinned so the difference is intentional rather than accidental.
    const socket = accountSocketBytes(new FakeReadSocket(), "pool-1") as unknown as FakeReadSocket;
    socket.emit("héllo");
    expect(poolByteTotals("pool-1").received).toBe(5);
  });

  test("the two wrappers are independent: a read never touches the sent total", () => {
    const socket = accountSocketBytes(new FakeReadSocket(), "pool-1") as unknown as FakeReadSocket;
    socket.emit(Buffer.from("x"));
    expect(poolByteTotals("pool-1").sent).toBe(0);
  });

  test("the wrapper returns the socket it was given, so call sites can chain", () => {
    const inner = new FakeReadSocket();
    expect(accountSocketBytes(inner, "pool-1")).toBe(inner);
  });
});

describe("parseCooldownEntry", () => {
  test("reads a well-formed entry", () => {
    expect(parseCooldownEntry(JSON.stringify(cooldown()))).toEqual({
      poolId: "pool-1",
      providerId: "provider-a",
      until: 1_000,
      reason: "rate limited",
    });
  });

  test("lowercases the provider id but leaves the pool id alone", () => {
    const parsed = parseCooldownEntry(
      JSON.stringify(cooldown({ poolId: "Pool-ABC", providerId: "Provider-XYZ" })),
    );
    // The provider id is lowercased because it is compared against ids that
    // arrive in mixed case; the pool id is a lookup key used verbatim.
    expect(parsed?.poolId).toBe("Pool-ABC");
    expect(parsed?.providerId).toBe("provider-xyz");
  });

  test("truncates the reason to 200 characters", () => {
    const parsed = parseCooldownEntry(JSON.stringify(cooldown({ reason: "z".repeat(500) })));
    expect(parsed?.reason).toHaveLength(200);
  });

  test("keeps a reason of exactly 200 characters intact", () => {
    const parsed = parseCooldownEntry(JSON.stringify(cooldown({ reason: "z".repeat(200) })));
    expect(parsed?.reason).toHaveLength(200);
  });

  test("accepts a negative `until`, which is a past instant and therefore not a cooldown", () => {
    // The parser validates the shape, not the clock; `isProviderCooldown`
    // compares `Date.now() < until` and drops it. Pinned so the split of
    // responsibility is explicit.
    expect(parseCooldownEntry(JSON.stringify(cooldown({ until: -1 })))?.until).toBe(-1);
  });

  test("accepts empty strings, since presence is what is validated", () => {
    const parsed = parseCooldownEntry(JSON.stringify(cooldown({ poolId: "", reason: "" })));
    expect(parsed?.poolId).toBe("");
    expect(parsed?.reason).toBe("");
  });

  test("ignores unknown fields rather than rejecting the entry", () => {
    const parsed = parseCooldownEntry(JSON.stringify({ ...cooldown(), injected: true }));
    expect(parsed).toEqual(cooldown());
    expect(parsed).not.toHaveProperty("injected");
  });

  test("returns undefined for malformed JSON instead of throwing", () => {
    expect(parseCooldownEntry("{")).toBeUndefined();
    expect(parseCooldownEntry("not json at all")).toBeUndefined();
    expect(parseCooldownEntry("")).toBeUndefined();
  });

  test("returns undefined for JSON that is not an object", () => {
    for (const raw of ["null", "[1,2]", '"a string"', "42", "true"]) {
      expect(parseCooldownEntry(raw)).toBeUndefined();
    }
  });

  test("returns undefined when any required field is missing or the wrong type", () => {
    const cases: ReadonlyArray<Record<string, unknown>> = [
      { providerId: "a", until: 1, reason: "r" },
      { poolId: "p", until: 1, reason: "r" },
      { poolId: "p", providerId: "a", reason: "r" },
      { poolId: "p", providerId: "a", until: 1 },
      { ...cooldown(), poolId: 1 },
      { ...cooldown(), providerId: null },
      { ...cooldown(), until: "1000" },
      { ...cooldown(), reason: 5 },
    ];
    for (const body of cases) {
      expect(parseCooldownEntry(JSON.stringify(body))).toBeUndefined();
    }
  });

  test("rejects a non-finite `until`, which no arithmetic comparison could use", () => {
    // JSON has no NaN/Infinity literal, so these arrive as `null` or as a
    // string — both rejected by the `typeof === "number"` check. The explicit
    // `Number.isFinite` guard covers the in-process callers.
    expect(parseCooldownEntry('{"poolId":"p","providerId":"a","until":null,"reason":"r"}')).toBeUndefined();
    expect(
      parseCooldownEntry('{"poolId":"p","providerId":"a","until":1e999,"reason":"r"}'),
    ).toBeUndefined();
  });
});

describe("rotationStart", () => {
  test("an unknown key starts at the first position", () => {
    const cursors = createPoolLocalState().rotationCursors;
    expect(rotationStart(cursors, "tenant-1", 4)).toBe(0);
  });

  test("a position past the end wraps into range", () => {
    const cursors = createPoolLocalState().rotationCursors;
    cursors.set("tenant-1", { pos: 7, served: 0 });
    expect(rotationStart(cursors, "tenant-1", 5)).toBe(2);
  });

  test("a position exactly on the length wraps to zero", () => {
    const cursors = createPoolLocalState().rotationCursors;
    cursors.set("tenant-1", { pos: 5, served: 0 });
    expect(rotationStart(cursors, "tenant-1", 5)).toBe(0);
  });

  test("a negative position wraps forward rather than returning a negative index", () => {
    // The `((pos % len) + len) % len` form exists for this case: JavaScript's
    // `%` keeps the sign of the dividend, so a bare `pos % len` would yield -3
    // and index the array from the end.
    const cursors = createPoolLocalState().rotationCursors;
    cursors.set("tenant-1", { pos: -3, served: 0 });
    expect(rotationStart(cursors, "tenant-1", 5)).toBe(2);
  });

  test("a single-candidate list always starts at zero", () => {
    const cursors = createPoolLocalState().rotationCursors;
    cursors.set("tenant-1", { pos: 99, served: 0 });
    expect(rotationStart(cursors, "tenant-1", 1)).toBe(0);
  });

  test("a very large position still lands in range", () => {
    const cursors = createPoolLocalState().rotationCursors;
    cursors.set("tenant-1", { pos: Number.MAX_SAFE_INTEGER, served: 0 });
    expect(rotationStart(cursors, "tenant-1", 7)).toBe(3);
  });

  test("an empty candidate list yields NaN, which no loop offset can use", () => {
    // The caller guards with `scored.length === 0` before reaching here, so this
    // is the boundary that guard protects. `NaN % n` is NaN and every
    // `(NaN + offset) % length` is NaN, so an unguarded call would index
    // `scored[NaN]` — undefined, silently skipped — rather than throw.
    const cursors = createPoolLocalState().rotationCursors;
    expect(Number.isNaN(rotationStart(cursors, "tenant-1", 0))).toBe(true);
  });

  test("keys are scoped: one tenant's cursor does not move another's", () => {
    const cursors = createPoolLocalState().rotationCursors;
    cursors.set("tenant-1", { pos: 3, served: 0 });
    expect(rotationStart(cursors, "tenant-2", 4)).toBe(0);
  });
});

describe("advanceRotation", () => {
  test("a fresh key anchors at the admitted index with one request served", () => {
    const cursors = createPoolLocalState().rotationCursors;
    advanceRotation(cursors, "tenant-1", 3, 0, 2);
    expect(cursors.get("tenant-1")).toEqual({ pos: 0, served: 1 });
  });

  test("the cursor holds until the pool has served rotateCount requests", () => {
    const cursors = createPoolLocalState().rotationCursors;
    advanceRotation(cursors, "tenant-1", 3, 0, 3);
    advanceRotation(cursors, "tenant-1", 3, 0, 3);
    expect(cursors.get("tenant-1")).toEqual({ pos: 0, served: 2 });
  });

  test("the cursor advances by exactly one position on the rotateCount-th request", () => {
    const cursors = createPoolLocalState().rotationCursors;
    for (let served = 0; served < 3; served += 1) {
      advanceRotation(cursors, "tenant-1", 3, 0, 3);
    }
    expect(cursors.get("tenant-1")).toEqual({ pos: 1, served: 0 });
  });

  test("two pools with rotateCount 2 alternate rather than pinning one pool", () => {
    // The regression the module comment records: advancing the *position* by
    // `rotateCount` steps would compute `(0 + 2) % 2` = 0 forever, so pool 0
    // would serve every request. Advancing by one gives a real alternation.
    const cursors = createPoolLocalState().rotationCursors;
    const starts: number[] = [];
    for (let request = 0; request < 6; request += 1) {
      const start = rotationStart(cursors, "tenant-1", 2);
      starts.push(start);
      advanceRotation(cursors, "tenant-1", 2, start, 2);
    }
    expect(starts).toEqual([0, 0, 1, 1, 0, 0]);
  });

  test("three pools with rotateCount 3 visit every pool in order", () => {
    const cursors = createPoolLocalState().rotationCursors;
    const starts: number[] = [];
    for (let request = 0; request < 9; request += 1) {
      const start = rotationStart(cursors, "tenant-1", 3);
      starts.push(start);
      advanceRotation(cursors, "tenant-1", 3, start, 3);
    }
    expect(starts).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2]);
  });

  test("an index that is not the current position re-anchors with a fresh count", () => {
    // The eligible list changed under the scan — it shrank, or failover jumped
    // past a full pool. Carrying the old served count would let the new pool
    // inherit credit it never earned.
    const cursors = createPoolLocalState().rotationCursors;
    advanceRotation(cursors, "tenant-1", 4, 0, 5);
    advanceRotation(cursors, "tenant-1", 4, 2, 5);
    expect(cursors.get("tenant-1")).toEqual({ pos: 2, served: 1 });
  });

  test("re-anchoring resets the count even when it was already at the threshold", () => {
    const cursors = createPoolLocalState().rotationCursors;
    advanceRotation(cursors, "tenant-1", 4, 0, 1);
    expect(cursors.get("tenant-1")).toEqual({ pos: 1, served: 0 });
    advanceRotation(cursors, "tenant-1", 4, 2, 1);
    expect(cursors.get("tenant-1")).toEqual({ pos: 2, served: 1 });
  });

  test("the last position wraps to the first", () => {
    const cursors = createPoolLocalState().rotationCursors;
    cursors.set("tenant-1", { pos: 2, served: 0 });
    advanceRotation(cursors, "tenant-1", 3, 2, 1);
    expect(cursors.get("tenant-1")).toEqual({ pos: 0, served: 0 });
  });

  test("rotateCount is clamped up to 1, so a zero never serves zero requests", () => {
    const cursors = createPoolLocalState().rotationCursors;
    advanceRotation(cursors, "tenant-1", 4, 0, 0);
    expect(cursors.get("tenant-1")).toEqual({ pos: 1, served: 0 });
  });

  test("a negative rotateCount is clamped up to 1 too", () => {
    const cursors = createPoolLocalState().rotationCursors;
    advanceRotation(cursors, "tenant-1", 4, 0, -5);
    expect(cursors.get("tenant-1")).toEqual({ pos: 1, served: 0 });
  });

  test("a fractional rotateCount is truncated, so 1.9 behaves as 1", () => {
    const cursors = createPoolLocalState().rotationCursors;
    advanceRotation(cursors, "tenant-1", 4, 0, 1.9);
    expect(cursors.get("tenant-1")).toEqual({ pos: 1, served: 0 });
  });

  test("rotateCount is clamped down to 1000, matching the account strategy", () => {
    const cursors = createPoolLocalState().rotationCursors;
    advanceRotation(cursors, "tenant-1", 4, 0, 5_000);
    expect(cursors.get("tenant-1")).toEqual({ pos: 0, served: 1 });
  });

  test("a rotateCount of exactly 1000 is honored rather than clamped to 999", () => {
    const cursors = createPoolLocalState().rotationCursors;
    advanceRotation(cursors, "tenant-1", 4, 0, 1_000);
    expect(cursors.get("tenant-1")).toEqual({ pos: 0, served: 1 });
  });

  test("a NaN rotateCount sticks the cursor, which is the safe direction", () => {
    // `Math.max(1, Math.min(1000, NaN))` is NaN, and `served >= NaN` is always
    // false, so the cursor never advances: the head pool keeps serving instead
    // of the rotation scattering. `rotateCount` is validated to an integer in
    // 1..1000 at both console write paths, so this is a boundary, not a path.
    const cursors = createPoolLocalState().rotationCursors;
    advanceRotation(cursors, "tenant-1", 4, 0, Number.NaN);
    expect(cursors.get("tenant-1")).toEqual({ pos: 0, served: 1 });
    // And it keeps counting without ever reaching the threshold.
    for (let request = 0; request < 5; request += 1) {
      advanceRotation(cursors, "tenant-1", 4, 0, Number.NaN);
    }
    expect(cursors.get("tenant-1")).toEqual({ pos: 0, served: 6 });
  });

  test("a zero-length candidate list records a NaN position", () => {
    // `(0 + 1) % 0` is NaN. The caller returns early on an empty list, so this
    // is the boundary that guard protects; a NaN position then makes
    // `rotationStart` NaN, which re-enters this function as a re-anchor.
    const cursors = createPoolLocalState().rotationCursors;
    advanceRotation(cursors, "tenant-1", 0, 0, 1);
    expect(Number.isNaN(cursors.get("tenant-1")?.pos)).toBe(true);
  });

  test("rotation state is scoped per key", () => {
    const cursors = createPoolLocalState().rotationCursors;
    advanceRotation(cursors, "tenant-1", 4, 0, 1);
    expect(cursors.has("tenant-2")).toBe(false);
    expect(cursors.get("tenant-1")).toEqual({ pos: 1, served: 0 });
  });

  test("the rotation cursor bound is 5,000 keys", () => {
    expect(MAX_ROTATION_KEYS).toBe(5_000);
  });

  test("a new key at the bound evicts the oldest-inserted cursor", () => {
    const cursors = createPoolLocalState().rotationCursors;
    for (let index = 0; index < MAX_ROTATION_KEYS; index += 1) {
      advanceRotation(cursors, `tenant-${index}`, 4, 0, 1);
    }
    expect(cursors.size).toBe(MAX_ROTATION_KEYS);

    advanceRotation(cursors, "tenant-overflow", 4, 0, 1);
    expect(cursors.size).toBe(MAX_ROTATION_KEYS);
    expect(cursors.has("tenant-0")).toBe(false);
    expect(cursors.has("tenant-overflow")).toBe(true);
  });

  test("advancing an existing key at the bound never evicts", () => {
    const cursors = createPoolLocalState().rotationCursors;
    for (let index = 0; index < MAX_ROTATION_KEYS; index += 1) {
      advanceRotation(cursors, `tenant-${index}`, 4, 0, 4);
    }
    // Existing keys take the first branch of the guard, so a hot tenant cannot
    // be evicted by its own traffic.
    advanceRotation(cursors, "tenant-0", 4, 0, 4);
    expect(cursors.size).toBe(MAX_ROTATION_KEYS);
    expect(cursors.has("tenant-0")).toBe(true);
  });
});

describe("enforceCooldownLimit", () => {
  test("the cooldown bound is 5,000 entries", () => {
    expect(MAX_COOLDOWN_ENTRIES).toBe(5_000);
  });

  test("a map below the bound is left completely untouched", () => {
    const cooldowns = new Map<string, ProxyCooldownEntry>();
    // Every entry is already expired: a sweep would empty the map. It must not
    // run, because the guard is on size, not on expiry — sweeping on every
    // insert would make the call O(n) on the hot path.
    for (let index = 0; index < MAX_COOLDOWN_ENTRIES - 1; index += 1) {
      cooldowns.set(`key-${index}`, cooldown({ until: 0 }));
    }
    enforceCooldownLimit(cooldowns);
    expect(cooldowns.size).toBe(MAX_COOLDOWN_ENTRIES - 1);
  });

  test("at the bound, expired entries are dropped and live ones survive", () => {
    const cooldowns = new Map<string, ProxyCooldownEntry>();
    const live = Date.now() + 60_000;
    for (let index = 0; index < MAX_COOLDOWN_ENTRIES; index += 1) {
      cooldowns.set(`key-${index}`, cooldown({ until: index % 2 === 0 ? 0 : live }));
    }
    enforceCooldownLimit(cooldowns);
    // The 2,500 expired entries go; the map is then below the bound, so the
    // oldest-first loop does not run at all.
    expect(cooldowns.size).toBe(MAX_COOLDOWN_ENTRIES / 2);
  });

  test("an entry expiring exactly now counts as expired", () => {
    // The comparison is `now >= entry.until`, so `until === now` is dead.
    const cooldowns = new Map<string, ProxyCooldownEntry>();
    for (let index = 0; index < MAX_COOLDOWN_ENTRIES - 1; index += 1) {
      cooldowns.set(`key-${index}`, cooldown({ until: Date.now() + 60_000 }));
    }
    cooldowns.set("expiring", cooldown({ until: Date.now() - 1 }));
    cooldowns.set("filler", cooldown({ until: Date.now() + 60_000 }));
    enforceCooldownLimit(cooldowns);
    expect(cooldowns.has("expiring")).toBe(false);
  });

  test("when nothing is expired, the oldest-inserted entries are evicted to below the bound", () => {
    const cooldowns = new Map<string, ProxyCooldownEntry>();
    const live = Date.now() + 60_000;
    for (let index = 0; index < MAX_COOLDOWN_ENTRIES; index += 1) {
      cooldowns.set(`key-${index}`, cooldown({ until: live }));
    }
    enforceCooldownLimit(cooldowns);
    // The loop runs while `size >= MAX`, so it evicts one entry and stops at
    // MAX - 1. The cap is a memory bound and the map is never read for a count,
    // so a steady state of MAX - 1 is equivalent to MAX.
    expect(cooldowns.size).toBe(MAX_COOLDOWN_ENTRIES - 1);
    expect(cooldowns.has("key-0")).toBe(false);
    expect(cooldowns.has("key-1")).toBe(true);
    expect(cooldowns.has(`key-${MAX_COOLDOWN_ENTRIES - 1}`)).toBe(true);
  });

  test("re-setting an existing key keeps its original insertion position", () => {
    // A `Map` does not move a key on `set`, so refreshing a cooldown does not
    // make it younger. Pinned because the eviction order depends on it.
    const cooldowns = new Map<string, ProxyCooldownEntry>();
    const live = Date.now() + 60_000;
    for (let index = 0; index < MAX_COOLDOWN_ENTRIES; index += 1) {
      cooldowns.set(`key-${index}`, cooldown({ until: live }));
    }
    cooldowns.set("key-0", cooldown({ until: live, reason: "refreshed" }));
    enforceCooldownLimit(cooldowns);
    expect(cooldowns.has("key-0")).toBe(false);
  });

  test("an empty map is a no-op", () => {
    const cooldowns = new Map<string, ProxyCooldownEntry>();
    enforceCooldownLimit(cooldowns);
    expect(cooldowns.size).toBe(0);
  });
});

describe("enforceInflightLimit", () => {
  test("the inflight bound is 10,000 entries", () => {
    expect(MAX_INFLIGHT_ENTRIES).toBe(10_000);
  });

  test("a map below the bound is left untouched", () => {
    const inflight = new Map<string, number>();
    for (let index = 0; index < MAX_INFLIGHT_ENTRIES - 1; index += 1) {
      inflight.set(`pool-${index}`, 1);
    }
    enforceInflightLimit(inflight);
    expect(inflight.size).toBe(MAX_INFLIGHT_ENTRIES - 1);
  });

  test("at the bound the oldest-inserted counter is evicted", () => {
    const inflight = new Map<string, number>();
    for (let index = 0; index < MAX_INFLIGHT_ENTRIES - 1; index += 1) {
      inflight.set(`pool-${index}`, 1);
    }
    inflight.set("pool-last", 1);
    enforceInflightLimit(inflight);
    expect(inflight.size).toBe(MAX_INFLIGHT_ENTRIES - 1);
    expect(inflight.has("pool-0")).toBe(false);
    expect(inflight.has("pool-last")).toBe(true);
  });

  test("eviction loses at most one pool's count, and only its local copy", () => {
    // The module comment records the tradeoff: with Redis the evicted pool's
    // count stays authoritative there and the local map only re-seeds, so the
    // worst case is one pool briefly over-admitting in this process.
    const inflight = new Map<string, number>();
    for (let index = 0; index < MAX_INFLIGHT_ENTRIES; index += 1) {
      inflight.set(`pool-${index}`, 3);
    }
    enforceInflightLimit(inflight);
    const evicted = inflight.has("pool-0");
    expect(evicted).toBe(false);
    // Every surviving counter kept its value — nothing was zeroed in place.
    expect(new Set(inflight.values())).toEqual(new Set([3]));
  });

  test("an empty map is a no-op", () => {
    const inflight = new Map<string, number>();
    enforceInflightLimit(inflight);
    expect(inflight.size).toBe(0);
  });
});

describe("createPoolLocalState", () => {
  test("starts with every map empty and the fairness cursor at zero", () => {
    const state = createPoolLocalState();
    expect(state.inflight.size).toBe(0);
    expect(state.cooldowns.size).toBe(0);
    expect(state.rotationCursors.size).toBe(0);
    expect(state.fairnessCursor).toBe(0);
  });

  test("each call returns independent maps", () => {
    const first = createPoolLocalState();
    const second = createPoolLocalState();
    first.inflight.set("pool-1", 1);
    first.rotationCursors.set("tenant-1", { pos: 1, served: 0 });
    expect(second.inflight.size).toBe(0);
    expect(second.rotationCursors.size).toBe(0);
  });
});
