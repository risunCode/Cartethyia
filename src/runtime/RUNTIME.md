# Runtime

`src/runtime/` owns process boot, dependency wiring, graceful shutdown, and
the small shared primitives (timeout, backoff, TTL cache) every layer reuses.
`lifecycle.ts` (`bootstrap()` + `ShutdownCoordinator`) and `dependencies.ts`
(`buildProductionDeps()`) are the composition spine: `src/main.ts` calls
`bootstrap()` once and caches the result on `globalThis` so `bun --hot`
reloads reuse it, then `src/app.ts` mounts routes from the returned
`ProductionDeps`.

## Layout

```text
src/runtime/
  RUNTIME.md          this file
  lifecycle.ts        ShutdownCoordinator + bootstrap() + CartethyiaBoot (globalThis reuse)
  dependencies.ts     buildProductionDeps() -> ProductionDeps (wiring order)
  timeout.ts          withTimeout() / timeoutAfter()
  backoff.ts          exponentialBackoff() with optional jitter
  ttl-cache.ts        TtlCache (bounded TTL + oldest-first eviction)
```

## Boot (`dependencies.ts`)

`buildProductionDeps()` runs in a strict order:

1. `getDb()`, `resolveRedisMode()`, `getRedis()` (skipped for
   `single_instance_local`), `resolveSsrfPolicy()`.
2. `ensureMigrated()` then `seedBundledProviders()`.
3. `createDefaultProviderRegistry()`, `liveProviderUpstreamHosts()`,
   `registerByokProviders()`, `bundledModelCatalog()`, `seedBundledModels()`.

Client-version discovery is **not** a boot step. The resolvers are TTL-cached
and every dispatch path awaits its own `ensure()`, so the pinned fallback
serves until the first request needs a version. Boot only fires
`refreshClineClientVersion()` after the listener is ready, so a blackholed
network cannot delay startup by the fetch timeout.
4. `InMemoryRouteSnapshotService` over the database snapshot builder,
   `RoutingEngine` (Redis admission controller when Redis exists),
   `DrizzleRuntimeSettingsStore`, `ApiKeyAdmissionService` (Redis or
   in-memory counter store plus the lifetime-consumed `COALESCE`
   reconciler), `IpAbuseProtectionService` (Redis or in-memory store).
5. Scheduled task registrations on `ScheduledTaskRegistry` interleaved with
   the constructions below, so each task sits next to the dependency it
   closes over — see `src/workers/WORKERS.md` for the table.
6. `TelemetryBatchBuffer`, `NetworkPoolSelector`, `PoolAgentResolver`,
   `ValidatedNetworkBindingFactory`, and `RuntimeMetricsSampler` (which reads
   live sizes through closures so observability never holds direct references
   to routing or pool state).
7. Return the `ProductionDeps` record: `db`,
   `redis`, `snapshotService`, `resolveProviderAdapter`,
   `bundledModelCatalog`, `byokUpstreamHosts`, `proxyPreparer`,
   `networkBindingFactory`, `ipAbuseProtection`, `readiness`,
   `scheduledTasks`, `poolAgentResolver`, `poolSelector`, `telemetryBuffer`,
   `trustedProxyBoundary`, `providerRegistry`, `resolveOAuthRefresher`,
   `oauthRefreshService`, `admissionService`.

`resolveProviderAdapter` and `resolveOAuthRefresher` are on-demand closures
over the registry, so heavy provider modules stay off the boot path.

## Shutdown (`lifecycle.ts`)

`ShutdownCoordinator` moves through `idle` → `stop_admitting` →
`bounded_drain_wait` → `flush_telemetry` → `close_pools` → `done`. It exposes
`track`/`untrack`/`isDraining`/`stopAdmitting`/`setAbortInflight`, and an
idempotent `begin(reason)` that stops admitting, aborts in-flight work, waits
for the drain (10ms spin, 8s budget), flushes telemetry (1s budget — a
deadline overrun still proceeds), then closes pools.

`bootstrap()` supplies the hooks: `flushTelemetry` is
`deps.telemetryBuffer.flush`, and `closePools` stops the server, stops
scheduled tasks, stops the telemetry buffer with a final flush, then settles
`closeDb()`, `closeRedis()`, and `poolAgentResolver.closeAll()` before
closing the network binding factory. `app.ts` wires
`setAbortInflight(() => requestStateStore.abortAll())` so the bounded drain
observes cancellation and finalizers run before the flush. `main.ts` adds
SIGINT/SIGTERM handlers with a 10s forced-exit backstop.

## Primitives

- `timeout.ts`: `withTimeout(promise, ms, message)` races and always clears
  the timer (`unref`'d); `timeoutAfter(ms, message)` is the standalone
  rejecter used by `closeRedis`. Readiness probes and the shutdown flush use
  `withTimeout` instead.
- `backoff.ts`: `exponentialBackoff(attempt, { baseDelayMs, maxDelayMs,
  jitter })` computes `min(max, base * 2^max(0, attempt))` with optional
  +25% jitter. Used by `network/retry.ts` (provider-version resolution) and
  the telemetry drain retry. Candidate failover keeps its own full-jitter
  `fallbackRetryDelayMs` in `transport/failure-policy.ts`, driven by
  `CARTETHYIA_FALLBACK_RETRY_BASE_MS` / `_CAP_MS`.
- `ttl-cache.ts`: `TtlCache` (default 5s TTL, 128 entries) with
  `get`/`set`/`has`/`delete`/`clear`/`keys`/`size`, plus `load(key, loader,
  { namespace, shouldCache })` — the single-flight read-through the provider
  caches actually use. `set` stamps the entry and
  runs `evictIfNeeded()` — an expired sweep first, then oldest-insertion
  eviction so `size` is a hard ceiling rather than just a sweep trigger.
  Revision-aware keys are built by callers: the preferences cache embeds the
  settings revision, while the discovery and version caches use
  caller-supplied static keys. `TtlCacheFamily<T>` is the set of `TtlCache`s
  keyed by TTL, created on first use: two provider-side caches each
  hand-rolled the same
  `Map<number, TtlCache<T>>` + `cacheFor(ttlMs)` memo, and tests pass
  `ttlMs: 0` to force a reload, which is why the per-TTL split exists.

## Configuration

`src/config.ts` is the only sanctioned multi-subsystem env reader. It declares
every variable it owns in one `CONFIG_SPEC` table (name, kind, default, bounds)
and implements its resolvers as thin readers over it, so adding a knob is one
table row plus a `.env.example` line. `test/config-env-drift.test.ts` derives
the documented variable set from `CONFIG_SPEC` and scans `src/` for both
`process.env.X` and `process.env["X"]` access, so a knob cannot be added without
declaring it.

Single-subsystem reads stay next to their consumer (logger level, telemetry
payload storage, Postgres pool tuning) and are only required to be documented in
`.env.example`. One read is structurally invisible to any scanner and is declared
explicitly in the drift test instead: `resolveRedisMode(env)` takes the
environment as a parameter.

Environment variables that merely bound an in-process cache or tune an internal
safety margin are **not** config surface — they are constants beside the code
that uses them (`PROXY_KEEP_ALIVE_TIMEOUT_MS`, `MODEL_CATALOG_CACHE_MAX_ENTRIES`,
the IP-abuse store bounds). Test seams are constructor parameters, never env.

## Rules

- Process-lifetime singletons live on `globalThis` (`__cartethyiaBoot`,
  `__cartethyiaPool`, `__cartethyiaDb`, `__cartethyiaRedis`) so `--hot`
  reloads reuse them instead of stacking intervals, workers, and pools. The
  same pattern guards the one-shot migration flag (`__cartethyiaMigrated`)
  and signal registration (`__cartethyiaSignalsRegistered`).
- Every shutdown stage is bounded; a stuck flush or pool close can delay exit
  but never hang it.
- `dependencies.ts` is the only module that knows the full wiring order —
  feature code receives its dependencies as constructor arguments.
