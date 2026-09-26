import { describe, expect, test } from "bun:test";
import type { NetworkPoolResponse } from "../../src/lib/contracts";
import { summarizePools } from "../../src/lib/proxy-metrics";

function pool(overrides: Partial<NetworkPoolResponse> = {}): NetworkPoolResponse {
  return {
    id: "p1",
    kind: "http",
    endpoint: "proxy-1",
    maxInflight: 10,
    status: "active",
    inflight: 0,
    consecutiveFailures: 0,
    tenantId: "tenant-1",
    ...overrides,
  } as NetworkPoolResponse;
}

describe("proxy pool overview metrics", () => {
  test("aggregates routable capacity and health split", () => {
    const pools = [
      pool({ id: "a", status: "active", maxInflight: 10, inflight: 4 }),
      pool({ id: "b", status: "active", maxInflight: 5, inflight: 1 }),
      pool({ id: "c", status: "cooldown", maxInflight: 8 }),
      pool({ id: "d", status: "cooldown", maxInflight: 4 }),
      pool({ id: "e", status: "disabled", maxInflight: 2 }),
    ];
    expect(summarizePools(pools)).toEqual({
      totalPools: 5,
      active: 2,
      cooldown: 2,
      totalMaxConcurrency: 15,
      usedInflight: 5,
      availableCapacity: 10,
    });
  });

  test("handles an empty pool list", () => {
    expect(summarizePools([])).toEqual({
      totalPools: 0,
      active: 0,
      cooldown: 0,
      totalMaxConcurrency: 0,
      usedInflight: 0,
      availableCapacity: 0,
    });
  });
});

describe("summarizePools with live usage", () => {
  test("live SSE rows override the polled inflight snapshot", () => {
    const pools = [
      pool({ id: "a", status: "active", maxInflight: 10, inflight: 1 }),
      pool({ id: "b", status: "active", maxInflight: 10, inflight: 1 }),
    ];
    const live = new Map([
      ["a", 7],
      ["b", 0],
    ]);
    expect(summarizePools(pools, live)).toEqual({
      totalPools: 2,
      active: 2,
      cooldown: 0,
      totalMaxConcurrency: 20,
      usedInflight: 7,
      availableCapacity: 13,
    });
  });

  test("a pool missing from the live map reads as zero", () => {
    const pools = [pool({ id: "a", status: "active", maxInflight: 10, inflight: 9 })];
    expect(summarizePools(pools, new Map()).usedInflight).toBe(0);
  });
});
