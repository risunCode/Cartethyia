import type { NetworkPoolResponse } from "../data/contracts";

/**
 * Mirrors the server's `MAX_BATCH_PROBE_TARGETS`.
 *
 * Deliberately duplicated rather than imported: the server constant lives in a
 * module that reaches Node-only code, and importing the value would pull that
 * into the browser bundle. The
 * server still enforces the real cap; this only keeps the UI from offering a
 * batch it would reject.
 */
export const MAX_BATCH_PROBE_TARGETS = 100;

export type PoolSortKey = "name" | "address" | "load";
export type PoolSortDirection = "asc" | "desc";

/** The value a column sorts on. `null` means "not known yet". */
function poolSortValue(
  pool: NetworkPoolResponse,
  key: PoolSortKey,
  latencyMs: number | undefined,
): string | number | null {
  switch (key) {
    case "name":
      return (pool.label || pool.endpoint).toLowerCase();
    case "address":
      return pool.egressIp ?? null;
    case "load":
      return latencyMs ?? null;
  }
}

/**
 * Sorts pools for the table without mutating the caller's array.
 *
 * Unknown values (no egress address yet, never probed) always sort last in
 * both directions: "unknown" is not the same as "smallest", and letting them
 * lead a descending sort would bury the pools that actually have data.
 */
export function sortPools(
  pools: readonly NetworkPoolResponse[],
  key: PoolSortKey,
  direction: PoolSortDirection,
  latencyOf: (pool: NetworkPoolResponse) => number | undefined,
): NetworkPoolResponse[] {
  const dir = direction === "asc" ? 1 : -1;
  return [...pools].sort((left, right) => {
    const a = poolSortValue(left, key, latencyOf(left));
    const b = poolSortValue(right, key, latencyOf(right));
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    if (typeof a === "number" && typeof b === "number") return (a - b) * dir;
    return String(a).localeCompare(String(b)) * dir;
  });
}

/**
 * Compact byte size for the usage bar. Uses binary units (KiB/MiB/GiB) because
 * that is how proxy providers bill, but prints the familiar short labels.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Whole numbers for bytes and KB read cleaner; larger units get one decimal.
  const digits = unit <= 1 ? 0 : value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export interface ProxyPoolSummary {
  readonly totalPools: number;
  readonly active: number;
  readonly cooldown: number;
  readonly totalMaxConcurrency: number;
  readonly usedInflight: number;
  readonly availableCapacity: number;
  /** Active pools with at least one free slot — the ones admission can pick. */
  readonly routablePools: number;
  /** Active pools fully occupied, i.e. temporarily unable to take a request. */
  readonly saturatedPools: number;
  /** Shortest cooldown still counting down, or null when nothing is cooling. */
  readonly soonestCooldownMs: number | null;
  /** Mean last-known latency across pools that have one, or null if none do. */
  readonly avgLatencyMs: number | null;
  /** How many pools that average is drawn from, so it can be read as a sample. */
  readonly measuredPools: number;
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
  // A pool with no free slot cannot serve a request right now, so it is not
  // routable even though its status is still `active`. Counting it separately
  // is what makes "3 enabled but 0 routable" visible instead of silently
  // reporting full capacity.
  let routablePools = 0;
  let saturatedPools = 0;
  for (const pool of activePools) {
    const used = liveInflightByPool === undefined ? (pool.inflight ?? 0) : (liveInflightByPool.get(pool.id) ?? 0);
    if (used >= pool.maxInflight) saturatedPools += 1;
    else routablePools += 1;
  }

  // Cooldowns are per provider and per pool; report the nearest one so the
  // operator knows how long the gap is, not just that one exists.
  let soonestCooldownMs: number | null = null;
  const now = Date.now();
  const consider = (until: string | undefined) => {
    if (!until) return;
    const at = Date.parse(until);
    if (Number.isNaN(at)) return;
    const remaining = at - now;
    if (remaining <= 0) return;
    if (soonestCooldownMs === null || remaining < soonestCooldownMs) soonestCooldownMs = remaining;
  };
  for (const pool of pools) {
    consider(pool.cooldownUntil);
    for (const provider of pool.providerCooldowns ?? []) consider(provider.until);
  }

  // Latency is last-known, not live: only pools that have succeeded at least
  // once carry a measurement, and averaging in the unmeasured ones would
  // understate the real figure. Disabled pools are excluded so the card
  // describes the pools that can actually serve traffic.
  const measured = activePools.filter(
    (pool) => pool.lastLatencyMs !== undefined && Number.isFinite(pool.lastLatencyMs),
  );
  const avgLatencyMs =
    measured.length === 0
      ? null
      : Math.round(measured.reduce((sum, pool) => sum + (pool.lastLatencyMs ?? 0), 0) / measured.length);
  return {
    totalPools: pools.length,
    active: activePools.length,
    cooldown: pools.filter((pool) => pool.status === "cooldown").length,
    totalMaxConcurrency,
    usedInflight,
    availableCapacity: Math.max(0, totalMaxConcurrency - usedInflight),
    routablePools,
    saturatedPools,
    soonestCooldownMs,
    avgLatencyMs,
    measuredPools: measured.length,
  };
}
