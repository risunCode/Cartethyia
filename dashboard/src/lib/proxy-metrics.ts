import type { NetworkPoolResponse } from "./contracts";

export interface ProxyPoolSummary {
  readonly totalPools: number;
  readonly active: number;
  readonly cooldown: number;
  readonly totalMaxConcurrency: number;
  readonly usedInflight: number;
  readonly availableCapacity: number;
}

/** Derives routable capacity and health state from the current pool list. */
export function summarizePools(
  pools: readonly NetworkPoolResponse[],
  liveInflightByPool?: ReadonlyMap<string, number>,
): ProxyPoolSummary {
  const activePools = pools.filter((pool) => pool.status === "active");
  const totalMaxConcurrency = activePools.reduce((sum, pool) => sum + pool.maxInflight, 0);
  // Live SSE usage wins over the polled `inflight` snapshot when present: the
  // snapshot only refreshes on list refetch, while the stream pushes every
  // acquire/release. Pools absent from the live map read as zero usage.
  const usedInflight =
    liveInflightByPool === undefined
      ? activePools.reduce((sum, pool) => sum + (pool.inflight ?? 0), 0)
      : activePools.reduce((sum, pool) => sum + (liveInflightByPool.get(pool.id) ?? 0), 0);
  return {
    totalPools: pools.length,
    active: activePools.length,
    cooldown: pools.filter((pool) => pool.status === "cooldown").length,
    totalMaxConcurrency,
    usedInflight,
    availableCapacity: Math.max(0, totalMaxConcurrency - usedInflight),
  };
}
