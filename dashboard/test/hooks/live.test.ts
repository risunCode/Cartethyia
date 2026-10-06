import { describe, expect, test } from "bun:test";
import { MAX_TRACKED_POOL_PEAKS, mergePools } from "../../src/hooks/live";
import type { PoolUsageRow } from "../../src/hooks/live";

function row(poolId: string, bytesSent = 0, bytesReceived = 0): PoolUsageRow {
  return { poolId, currentInflight: 0, bytesSent, bytesReceived };
}

describe("mergePools", () => {
  test("inserts rows for pools seen for the first time", () => {
    const peaks = new Map<string, PoolUsageRow>();
    const next = mergePools(peaks, [row("p1", 100, 50), row("p2", 10, 5)]);
    expect(next).toHaveLength(2);
    expect(peaks.size).toBe(2);
    expect(peaks.get("p1")).toEqual(row("p1", 100, 50));
  });

  test("keeps the highest bytes seen per pool across frames", () => {
    const peaks = new Map<string, PoolUsageRow>();
    mergePools(peaks, [row("p1", 100, 50)]);
    const next = mergePools(peaks, [row("p1", 40, 200)]);
    expect(next).toHaveLength(1);
    expect(next[0]).toEqual({ poolId: "p1", currentInflight: 0, bytesSent: 100, bytesReceived: 200 });
  });

  test("retains the last peak for a pool absent from the frame", () => {
    const peaks = new Map<string, PoolUsageRow>();
    mergePools(peaks, [row("p1", 100, 50)]);
    // A reconnect snapshot that temporarily omits the pool must not snap it to 0B.
    const next = mergePools(peaks, []);
    expect(next).toHaveLength(1);
    expect(next[0]).toEqual(row("p1", 100, 50));
  });

  test("bounds remembered peaks, evicting oldest-inserted entries", () => {
    const peaks = new Map<string, PoolUsageRow>();
    // Fill to the cap plus one extra: the first pool must be evicted.
    for (let i = 0; i <= MAX_TRACKED_POOL_PEAKS; i += 1) {
      mergePools(peaks, [row(`pool-${i}`, i, i)]);
    }
    expect(peaks.size).toBe(MAX_TRACKED_POOL_PEAKS);
    expect(peaks.has("pool-0")).toBe(false);
    expect(peaks.has(`pool-${MAX_TRACKED_POOL_PEAKS}`)).toBe(true);
  });

  test("re-touching a pool refreshes its bytes but not its insertion order", () => {
    const peaks = new Map<string, PoolUsageRow>();
    mergePools(peaks, [row("p1", 1, 1), row("p2", 2, 2)]);
    // p1 appears in a later frame, so it is the most recently *seen* pool, but
    // its map slot was not re-inserted — eviction still falls to the oldest key.
    for (let i = 0; i < MAX_TRACKED_POOL_PEAKS; i += 1) {
      mergePools(peaks, [row(`pool-${i}`, 1, 1), row("p1", 5, 5)]);
    }
    expect(peaks.size).toBe(MAX_TRACKED_POOL_PEAKS);
    expect(peaks.get("p1")).toEqual(row("p1", 5, 5));
    // p2 was the second-oldest insert and is evicted before p1's refreshed bytes.
    expect(peaks.has("p2")).toBe(false);
    expect(peaks.has("p1")).toBe(true);
  });
});
