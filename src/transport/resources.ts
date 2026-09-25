// Live process-wide resource bounds and the bound assertion that guards them.

/**
 * Live process-wide resource bounds. Only bounds with a production consumer
 * live here: `maxPostgresPoolSize` feeds `poolMaxFromEnv()`, and
 * `maxTelemetryQueueBytes` caps `TelemetryBatchBuffer`. Everything else
 * that used to live in this module (`maxRedisPoolSize`, provider/network/
 * catalog/replay bounds, `BoundedConfig` + its validators) had zero callers
 * and was removed — re-add a bound only with its consumer in the same change.
 */
export const DEFAULT_BOUNDS = {
  maxTelemetryQueueBytes: 10 * 1024 * 1024,
  /**
   * Ceiling on concurrent Postgres connections per gateway process.
   *
   * This is a *ceiling*, not a reservation: the pool opens connections on
   * demand and returns them to idle, so a value the workload never reaches
   * costs nothing today — it only bounds the worst case. The old value (60)
   * was justified in a comment as "bursty 10k-inflight traffic", which is a
   * property of the proxy path. The proxy path is *mostly* database-free —
   * routing comes from `InMemoryRouteSnapshotService` and admission counters
   * live in Redis — but not entirely: a dispatch attempt resolves its
   * credential with a per-attempt read, health transitions write, and tenant
   * preferences are read behind a short cache. Those are small, bounded reads
   * on the request's own attempt, not a per-request fan-out. The larger
   * database consumers remain the console API, one telemetry flush at a time,
   * the worker sweeps (`runGrowingWaves`, at most 5 concurrent), auth, and
   * readiness.
   *
   * 20 leaves headroom over that without letting one process hold a large
   * share of the server's `max_connections` (Postgres defaults to 100), which
   * matters because the gateway is designed to run several processes behind
   * `reusePort` — see `assertPoolFitsServerCapacity`.
   */
  maxPostgresPoolSize: 20,
} as const;
