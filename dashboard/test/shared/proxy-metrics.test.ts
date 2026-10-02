/**
 * Proxy pool table: sorting, byte formatting, and the derived capacity summary.
 *
 * Three things here are load-bearing for an operator:
 *
 * 1. **"Unknown" must not sort as "smallest".** A pool that has never been probed
 *    has no latency and no egress address. If those read as `0`/`""` they would
 *    lead an ascending sort, burying the pools that actually have data under the
 *    ones that have none.
 * 2. **Capacity arithmetic must not report negative headroom.** `availableCapacity`
 *    is what the operator reads to decide whether to add a pool.
 * 3. **The mirrored batch cap must not drift from the server's.** The dashboard
 *    deliberately duplicates `MAX_BATCH_PROBE_TARGETS` instead of importing it (the
 *    server module reaches Node-only code). A test that imports both is the only
 *    thing that catches the two literals diverging — and it can, because the test
 *    process is not the browser bundle.
 *
 * `sortPools` takes the latency as a callback so the table can sort by a live
 * probe value the pool object does not carry; the tests drive it explicitly.
 */
import { describe, expect, test } from "bun:test";
import type { NetworkPoolResponse } from "../../src/data/contracts";
import {
  formatBytes,
  MAX_BATCH_PROBE_TARGETS,
  type PoolSortDirection,
  type PoolSortKey,
  sortPools,
  summarizePools,
} from "../../src/shared/proxy-metrics";
import { MAX_BATCH_PROBE_TARGETS as SERVER_MAX_BATCH_PROBE_TARGETS } from "../../../src/console/routing/pools/contracts";

/** Minimal pool; only the fields the unit under test reads are set. */
function pool(overrides: Partial<NetworkPoolResponse> & { id: string }): NetworkPoolResponse {
  return {
    kind: "http",
    endpoint: `http://${overrides.id}.example:8080`,
    maxInflight: 10,
    weight: 1,
    status: "active",
    inflight: 0,
    consecutiveFailures: 0,
    tenantId: "t1",
    ...overrides,
  };
}

const noLatency = (): undefined => undefined;

describe("MAX_BATCH_PROBE_TARGETS", () => {
  test("the dashboard mirror equals the server's cap", () => {
    // The mirror's own comment says the duplication is deliberate because
    // `pools/contracts` imports Elysia and `node:crypto`. That reasoning is about
    // the BROWSER bundle; a test process may import both, so this asserts the
    // invariant the comment relies on. Without it, the two literals could drift
    // and the UI would offer a batch the server rejects with a 400.
    expect(MAX_BATCH_PROBE_TARGETS).toBe(SERVER_MAX_BATCH_PROBE_TARGETS);
  });

  test("it is the documented value", () => {
    expect(MAX_BATCH_PROBE_TARGETS).toBe(100);
  });
});

describe("sortPools", () => {
  const alpha = pool({ id: "alpha", label: "Alpha", egressIp: "203.0.113.5" });
  const beta = pool({ id: "beta", label: "beta", egressIp: "198.51.100.9" });
  const gamma = pool({ id: "gamma", egressIp: "192.0.2.7" });

  test("the caller's array is not mutated", () => {
    // The table sorts on every render; mutating the hook's array would reorder
    // the source of truth and make the next render's order depend on the last
    // sort, not on the data.
    const input = [alpha, beta, gamma];
    const before = [...input];
    sortPools(input, "name", "asc", noLatency);
    expect(input).toEqual(before);
  });

  test("name sorts case-insensitively and falls back to the endpoint", () => {
    // `(pool.label || pool.endpoint).toLowerCase()` — a pool with no label is
    // identified by its endpoint, and "beta" must not sort after "Alpha" merely
    // because of its case.
    const sorted = sortPools([beta, alpha, gamma], "name", "asc", noLatency);
    expect(sorted.map((p) => p.id)).toEqual(["alpha", "beta", "gamma"]);
  });

  test("address sorts lexicographically on the egress IP", () => {
    // String comparison, not numeric: these are dotted quads, so "192.0.2.7" <
    // "198.51.100.9" < "203.0.113.5". Pinned because a numeric parser would be a
    // different order for some inputs.
    const sorted = sortPools([alpha, gamma, beta], "address", "asc", noLatency);
    expect(sorted.map((p) => p.egressIp)).toEqual(["192.0.2.7", "198.51.100.9", "203.0.113.5"]);
  });

  test("descending reverses each string sort", () => {
    const sorted = sortPools([alpha, beta, gamma], "name", "desc", noLatency);
    expect(sorted.map((p) => p.id)).toEqual(["gamma", "beta", "alpha"]);
  });

  test("load sorts numerically, not as strings", () => {
    // The discriminating case: as strings "100" < "9". A `localeCompare` on a
    // number would get this wrong.
    const slow = pool({ id: "slow" });
    const fast = pool({ id: "fast" });
    const mid = pool({ id: "mid" });
    const latency = (p: NetworkPoolResponse): number | undefined =>
      ({ slow: 100, fast: 9, mid: 20 })[p.id] as number | undefined;
    const sorted = sortPools([slow, fast, mid], "load", "asc", latency);
    expect(sorted.map((p) => p.id)).toEqual(["fast", "mid", "slow"]);
  });

  test("unknown values sort last in BOTH directions", () => {
    // The documented rule, and the reason it exists: a pool with no measurement
    // must not be presented as the fastest (ascending) or the slowest
    // (descending) — it has no rank at all, so it goes to the end either way.
    const measured = pool({ id: "measured" });
    const unmeasured = pool({ id: "unmeasured" });
    const latency = (p: NetworkPoolResponse): number | undefined =>
      p.id === "measured" ? 50 : undefined;

    for (const direction of ["asc", "desc"] as const satisfies readonly PoolSortDirection[]) {
      const sorted = sortPools([unmeasured, measured], "load", direction, latency);
      expect(sorted.map((p) => p.id)).toEqual(["measured", "unmeasured"]);
    }
  });

  test("a pool with no egress address sorts last by address", () => {
    const probed = pool({ id: "probed", egressIp: "203.0.113.5" });
    const unprobed = pool({ id: "unprobed" });
    for (const direction of ["asc", "desc"] as const satisfies readonly PoolSortDirection[]) {
      expect(sortPools([unprobed, probed], "address", direction, noLatency).map((p) => p.id)).toEqual(
        ["probed", "unprobed"],
      );
    }
  });

  test("two unknown values keep their relative order", () => {
    // The `a === null && b === null` branch returns 0, so the sort is stable for
    // the unranked group rather than shuffling them on every render.
    const first = pool({ id: "first" });
    const second = pool({ id: "second" });
    expect(sortPools([first, second], "load", "asc", noLatency).map((p) => p.id)).toEqual([
      "first",
      "second",
    ]);
  });

  test("equal values keep their relative order", () => {
    const a = pool({ id: "a", egressIp: "203.0.113.5" });
    const b = pool({ id: "b", egressIp: "203.0.113.5" });
    expect(sortPools([a, b], "address", "asc", noLatency).map((p) => p.id)).toEqual(["a", "b"]);
  });

  test("an empty list sorts to an empty list", () => {
    expect(sortPools([], "name", "asc", noLatency)).toEqual([]);
  });

  test("a single-element list is returned as a new array", () => {
    const input = [alpha];
    const result = sortPools(input, "name", "asc", noLatency);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
  });

  test("a label takes precedence over the endpoint for the name key", () => {
    // A labelled pool sorts by its label even when the endpoint would sort
    // differently, which is what makes the operator's own naming authoritative.
    const labelled = pool({ id: "zzz", label: "Aardvark", endpoint: "http://zzz.example" });
    const unlabelled = pool({ id: "aaa", endpoint: "http://aaa.example" });
    const sorted = sortPools([unlabelled, labelled], "name", "asc", noLatency);
    expect(sorted.map((p) => p.id)).toEqual(["zzz", "aaa"]);
  });

  test("an empty label falls back to the endpoint", () => {
    // `pool.label || pool.endpoint` — an empty string is falsy, so a pool saved
    // with a blank label still sorts by something rather than by "".
    const blank = pool({ id: "blank", label: "", endpoint: "http://aardvark.example" });
    const other = pool({ id: "other", endpoint: "http://zebra.example" });
    expect(sortPools([other, blank], "name", "asc", noLatency).map((p) => p.id)).toEqual([
      "blank",
      "other",
    ]);
  });

  test("every key and direction pair produces a permutation of the input", () => {
    // A sweep so no branch can drop or duplicate a row. The table renders
    // whatever comes back, so a lost pool would silently vanish from the UI.
    const pools = [
      pool({ id: "p1", label: "One", egressIp: "203.0.113.1" }),
      pool({ id: "p2", label: "Two" }),
      pool({ id: "p3", egressIp: "198.51.100.2" }),
      pool({ id: "p4", label: "Four", egressIp: "192.0.2.3" }),
    ];
    const keys = ["name", "address", "load"] as const satisfies readonly PoolSortKey[];
    const latency = (p: NetworkPoolResponse): number | undefined =>
      ({ p1: 10, p2: 30, p4: 20 })[p.id] as number | undefined;

    for (const key of keys) {
      for (const direction of ["asc", "desc"] as const satisfies readonly PoolSortDirection[]) {
        const sorted = sortPools(pools, key, direction, latency);
        expect(sorted).toHaveLength(pools.length);
        expect(new Set(sorted.map((p) => p.id))).toEqual(new Set(pools.map((p) => p.id)));
      }
    }
  });
});

describe("formatBytes", () => {
  test("zero and negative report as zero", () => {
    // The bar's floor: a pool with no allowance yet, or a counter that
    // overshot, must not render "-1.0 KB".
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(-1024 * 1024)).toBe("0 B");
  });

  test("a non-finite value reports as zero rather than NaN", () => {
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
    expect(formatBytes(Number.NEGATIVE_INFINITY)).toBe("0 B");
  });

  test("bytes below a kibibyte print as whole bytes", () => {
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  test("the kibibyte boundary switches unit", () => {
    // 1024 is the first value that divides; the label stays "KB" (binary
    // quantity, familiar label — documented in the module).
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("2 KB");
  });

  test("KB prints no decimal", () => {
    // `unit <= 1 ? 0 : ...` — whole numbers for bytes and KB.
    expect(formatBytes(10 * 1024)).toBe("10 KB");
    expect(formatBytes(1024 * 1024 - 1)).toBe("1024 KB");
  });

  test("MB and above get one decimal below ten and none at ten or more", () => {
    // The `value < 10 ? 1 : 0` rule, so the column stays a consistent width.
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 * 1024 * 5)).toBe("5.0 MB");
    expect(formatBytes(1024 * 1024 * 10)).toBe("10 MB");
    expect(formatBytes(1024 * 1024 * 512)).toBe("512 MB");
  });

  test("the unit ladder reaches TB and stops there", () => {
    // `unit < units.length - 1` caps the division, so a value past a terabyte is
    // reported in TB rather than running off the end of the label array.
    expect(formatBytes(1024 ** 4)).toBe("1.0 TB");
    expect(formatBytes(1024 ** 5)).toBe("1024 TB");
    expect(formatBytes(1024 ** 6)).toBe("1048576 TB");
  });

  test("the output always carries a unit label and no NaN", () => {
    // A sweep across magnitudes, including the exact boundaries.
    const inputs = [
      0, 1, 1023, 1024, 1025, 1024 ** 2, 1024 ** 2 + 1, 1024 ** 3, 1024 ** 4, 1024 ** 5,
      Number.MAX_SAFE_INTEGER,
    ];
    for (const bytes of inputs) {
      const rendered = formatBytes(bytes);
      expect(rendered).toMatch(/^\d+(\.\d)? (B|KB|MB|GB|TB)$/);
      expect(rendered).not.toContain("NaN");
    }
  });
});

describe("summarizePools", () => {
  test("an empty list reports an empty, null-latency summary", () => {
    // The card renders this before the first poll resolves; nulls are what make
    // it show "—" rather than "0 ms".
    expect(summarizePools([])).toEqual({
      totalPools: 0,
      active: 0,
      cooldown: 0,
      totalMaxConcurrency: 0,
      usedInflight: 0,
      availableCapacity: 0,
      routablePools: 0,
      saturatedPools: 0,
      soonestCooldownMs: null,
      avgLatencyMs: null,
      measuredPools: 0,
    });
  });

  test("only active pools contribute capacity", () => {
    // A disabled or cooling pool is not capacity the operator can spend, so it
    // must not inflate the denominator.
    const pools = [
      pool({ id: "a", maxInflight: 10 }),
      pool({ id: "b", maxInflight: 20, status: "disabled" }),
      pool({ id: "c", maxInflight: 30, status: "cooldown" }),
    ];
    const summary = summarizePools(pools);
    expect(summary.totalPools).toBe(3);
    expect(summary.active).toBe(1);
    expect(summary.cooldown).toBe(1);
    expect(summary.totalMaxConcurrency).toBe(10);
  });

  test("used inflight sums the active pools only", () => {
    const pools = [
      pool({ id: "a", inflight: 3 }),
      pool({ id: "b", inflight: 4, status: "disabled" }),
      pool({ id: "c", inflight: 5 }),
    ];
    expect(summarizePools(pools).usedInflight).toBe(8);
  });

  test("a pool with no inflight field reads as zero", () => {
    // `pool.inflight ?? 0` — the field is required on the contract but a
    // partially-shaped response must not produce NaN.
    const pools = [{ ...pool({ id: "a" }), inflight: undefined as unknown as number }];
    expect(summarizePools(pools).usedInflight).toBe(0);
  });

  test("a saturated pool is counted but not routable", () => {
    // The distinction the field exists for: the pool is still `active`, so it
    // counts toward `active`, but it cannot take a request.
    const pools = [
      pool({ id: "free", maxInflight: 10, inflight: 1 }),
      pool({ id: "full", maxInflight: 10, inflight: 10 }),
      pool({ id: "over", maxInflight: 10, inflight: 12 }),
    ];
    const summary = summarizePools(pools);
    expect(summary.active).toBe(3);
    expect(summary.routablePools).toBe(1);
    expect(summary.saturatedPools).toBe(2);
  });

  test("the boundary is used >= maxInflight, so exactly-full is saturated", () => {
    const summary = summarizePools([pool({ id: "exact", maxInflight: 5, inflight: 5 })]);
    expect(summary.saturatedPools).toBe(1);
    expect(summary.routablePools).toBe(0);
  });

  test("available capacity never goes negative", () => {
    // The `Math.max(0, ...)` guard: a pool reporting more inflight than its
    // limit (a race between the snapshot and a release) must not render
    // "-2 available".
    const summary = summarizePools([pool({ id: "over", maxInflight: 5, inflight: 9 })]);
    expect(summary.availableCapacity).toBe(0);
  });

  test("the live inflight map overrides the polled snapshot", () => {
    // Documented: the SSE stream pushes every acquire/release, while `inflight`
    // only refreshes on a list refetch. Trusting the snapshot would show stale
    // capacity.
    const pools = [pool({ id: "a", maxInflight: 10, inflight: 9 })];
    const live = new Map([["a", 2]]);
    const summary = summarizePools(pools, live);
    expect(summary.usedInflight).toBe(2);
    expect(summary.availableCapacity).toBe(8);
    expect(summary.routablePools).toBe(1);
  });

  test("a pool absent from the live map reads as zero usage", () => {
    // Documented: "Pools absent from the live map read as zero usage." The map
    // only carries pools the stream has mentioned.
    const pools = [pool({ id: "a", maxInflight: 10, inflight: 9 })];
    const summary = summarizePools(pools, new Map());
    expect(summary.usedInflight).toBe(0);
    expect(summary.routablePools).toBe(1);
  });

  test("an empty live map is different from no live map", () => {
    // The discriminating case for `liveInflightByPool === undefined`: an empty
    // map is a live source that says "nothing is in flight", which is not the
    // same as falling back to the snapshot.
    const pools = [pool({ id: "a", maxInflight: 10, inflight: 7 })];
    expect(summarizePools(pools).usedInflight).toBe(7);
    expect(summarizePools(pools, new Map()).usedInflight).toBe(0);
  });

  test("a live map over the limit saturates the pool", () => {
    const pools = [pool({ id: "a", maxInflight: 4, inflight: 0 })];
    const summary = summarizePools(pools, new Map([["a", 4]]));
    expect(summary.saturatedPools).toBe(1);
    expect(summary.routablePools).toBe(0);
    expect(summary.availableCapacity).toBe(0);
  });

  test("the soonest cooldown is the smallest still-future deadline", () => {
    // The operator reads this as "how long is the gap", so a later deadline
    // must not win.
    const soon = new Date(Date.now() + 30_000).toISOString();
    const later = new Date(Date.now() + 120_000).toISOString();
    const pools = [
      pool({ id: "a", cooldownUntil: later, status: "cooldown" }),
      pool({ id: "b", cooldownUntil: soon, status: "cooldown" }),
    ];
    const summary = summarizePools(pools);
    expect(summary.soonestCooldownMs).not.toBeNull();
    // Bounded rather than exact: the clock advances between the fixture and the
    // call, so asserting 30_000 would be flaky.
    expect(summary.soonestCooldownMs).toBeLessThanOrEqual(30_000);
    expect(summary.soonestCooldownMs).toBeGreaterThan(28_000);
  });

  test("an elapsed cooldown is not reported", () => {
    // `remaining <= 0` is skipped: a deadline in the past is not a gap to wait
    // for, and reporting it would show a negative or zero countdown.
    const pools = [pool({ id: "a", cooldownUntil: new Date(Date.now() - 60_000).toISOString() })];
    expect(summarizePools(pools).soonestCooldownMs).toBeNull();
  });

  test("an unparseable cooldown deadline is ignored, not treated as zero", () => {
    // `Number.isNaN(at)` guard. Without it `NaN - now` is NaN and the
    // comparison `remaining < soonest` is false, so it would be skipped anyway —
    // but with a single entry `soonestCooldownMs` would be set to NaN. Pinned.
    const pools = [pool({ id: "a", cooldownUntil: "not-a-date" })];
    expect(summarizePools(pools).soonestCooldownMs).toBeNull();
  });

  test("per-provider cooldowns are considered alongside pool cooldowns", () => {
    // The card's gap can come from a provider being throttled rather than the
    // pool itself; the `providerCooldowns` loop is what surfaces it.
    const until = new Date(Date.now() + 45_000).toISOString();
    const pools = [
      pool({
        id: "a",
        providerCooldowns: [{ providerId: "anthropic", until, reason: "429" }],
      }),
    ];
    const summary = summarizePools(pools);
    expect(summary.soonestCooldownMs).not.toBeNull();
    expect(summary.soonestCooldownMs).toBeLessThanOrEqual(45_000);
  });

  test("cooldowns are read from every pool, including non-active ones", () => {
    // Unlike capacity, the cooldown scan iterates `pools`, not `activePools`:
    // a pool that is mid-cooldown has `status: "cooldown"` and would be missed
    // otherwise — which is exactly the case the field exists to describe.
    const until = new Date(Date.now() + 60_000).toISOString();
    const pools = [pool({ id: "a", status: "cooldown", cooldownUntil: until })];
    const summary = summarizePools(pools);
    expect(summary.active).toBe(0);
    expect(summary.soonestCooldownMs).not.toBeNull();
  });

  test("the latency average covers only measured active pools", () => {
    // Documented: averaging in unmeasured pools would understate the figure, and
    // a disabled pool is not serving traffic so its last latency is not
    // representative of current capacity.
    const pools = [
      pool({ id: "a", lastLatencyMs: 100 }),
      pool({ id: "b", lastLatencyMs: 200 }),
      pool({ id: "unmeasured" }),
      pool({ id: "disabled", lastLatencyMs: 900, status: "disabled" }),
    ];
    const summary = summarizePools(pools);
    expect(summary.avgLatencyMs).toBe(150);
    expect(summary.measuredPools).toBe(2);
  });

  test("the average is rounded to a whole millisecond", () => {
    // `Math.round` so the card does not print a fractional latency.
    const summary = summarizePools([
      pool({ id: "a", lastLatencyMs: 100 }),
      pool({ id: "b", lastLatencyMs: 101 }),
    ]);
    expect(summary.avgLatencyMs).toBe(101);
    expect(Number.isInteger(summary.avgLatencyMs)).toBe(true);
  });

  test("a non-finite latency is excluded from the average", () => {
    // `Number.isFinite(pool.lastLatencyMs)` — a NaN or Infinity would poison the
    // mean and render "NaN ms".
    const pools = [
      pool({ id: "a", lastLatencyMs: 100 }),
      pool({ id: "nan", lastLatencyMs: Number.NaN }),
      pool({ id: "inf", lastLatencyMs: Number.POSITIVE_INFINITY }),
    ];
    const summary = summarizePools(pools);
    expect(summary.avgLatencyMs).toBe(100);
    expect(summary.measuredPools).toBe(1);
  });

  test("no measurements reports null rather than zero", () => {
    // The card must show "—" (not measured) rather than "0 ms" (instantaneous).
    const summary = summarizePools([pool({ id: "a" })]);
    expect(summary.avgLatencyMs).toBeNull();
    expect(summary.measuredPools).toBe(0);
  });

  test("a zero-millisecond measurement is included, not treated as absent", () => {
    // The discriminating case for the `!== undefined` check: 0 is a real
    // measurement (a loopback relay), and a truthiness check would drop it.
    const summary = summarizePools([pool({ id: "a", lastLatencyMs: 0 })]);
    expect(summary.avgLatencyMs).toBe(0);
    expect(summary.measuredPools).toBe(1);
  });

  test("mixed statuses produce a self-consistent summary", () => {
    // An end-to-end shape check: the counts must add up to what the operator
    // sees, and capacity must equal the difference it claims to be.
    const pools = [
      pool({ id: "free", maxInflight: 10, inflight: 4, lastLatencyMs: 50 }),
      pool({ id: "full", maxInflight: 10, inflight: 10, lastLatencyMs: 70 }),
      pool({ id: "cooling", maxInflight: 10, inflight: 0, status: "cooldown" }),
      pool({ id: "off", maxInflight: 10, inflight: 0, status: "disabled" }),
    ];
    const summary = summarizePools(pools);
    expect(summary.totalPools).toBe(4);
    expect(summary.active + summary.cooldown + 1).toBe(4); // +1 disabled
    expect(summary.routablePools + summary.saturatedPools).toBe(summary.active);
    expect(summary.totalMaxConcurrency).toBe(20);
    expect(summary.usedInflight).toBe(14);
    expect(summary.availableCapacity).toBe(summary.totalMaxConcurrency - summary.usedInflight);
    expect(summary.avgLatencyMs).toBe(60);
  });
});
