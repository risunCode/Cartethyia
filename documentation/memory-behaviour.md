# Memory behaviour: what is normal, what is a leak, and what is still open

This file exists because the gateway's memory footprint was measured carefully and
the conclusions were **not** what a code reading suggested. Every number below was
measured on a clean non-hot process, not inferred.

## The headline split

A clean non-hot boot, idle, after the database and catalog are loaded:

| Field | Value |
|---|---|
| `rss` | **141 MB** |
| `heapUsed` | **24 MB** |
| `heapTotal` | 20 MB |
| `external` | 7 MB |
| `arrayBuffers` | 0 MB |

**Only 24 MB of the 141 MB is JavaScript heap.** The remaining ~117 MB is native:
the Bun/JSC runtime itself, OpenSSL, `bun:sqlite`'s page cache, and the `pg`
client's pool. That is fixed runtime cost, not retained objects, and **no amount of
code restructuring reduces it** — the levers are configuration
(`DATABASE_POOL_MAX`, `PRAGMA cache_size`, `PRAGMA temp_store`), not architecture.

The practical consequence: **`rss` alone tells you almost nothing.** A high `rss`
with a flat `heapUsed` is the native floor. A *rising* `heapUsed` is a leak. Always
read the split.

Under 150 real non-streaming chat turns (every one HTTP 200) `rss` went **down**,
143 MB → 32 MB, with `heapUsed` flat at 24 MB. The non-streaming path does not leak.

## `bun run dev` is not a measurement environment

`dev:backend` runs `bun run --hot src/main.ts`, and **hot reload retains roughly
25–30 MB of memory per reload, monotonically**. Measured across six reloads:

```
boot          102 MB
reload #1     133 MB   (+31)
reload #2     160 MB   (+27)
reload #3     186 MB   (+26)
reload #4     210 MB   (+24)
reload #5      25 MB   (process restarted)
reload #6     118 MB
```

Each superseded module instance — and every cache, timer, and listener it closed
over — stays reachable, so a developer who reloads constantly watches the process
climb past 500 MB and conclude the gateway leaks. It does not: the production
binary never hot-reloads, so this does not transfer. In one session with a few dozen
source edits the dev server reached 1.7 GB, which is exactly this mechanism at scale.

**If you are investigating memory, do not measure the `--hot` server.** Restart it
first, or run `bun run src/main.ts` directly.

> **Open, for a future reader:** the retention above is a property of Bun's hot
> reload, not of this repository, so it is documented rather than fixed here. What
> *would* be worth doing is making the development experience not mislead — for
> example having `dev:backend` print the reload count beside the memory reading, or
> documenting the restart-to-measure rule inside the dev script's own output. The
> cheapest correct fix is the one that stops a reader trusting the number.

## Where to read the split

The instrumentation already exists; nothing needs to be added to answer "is this a
leak?".

- **Prometheus gauges** — `cartethyia_memory_rss_bytes`,
  `cartethyia_memory_heap_used_bytes`, `cartethyia_memory_heap_total_bytes`,
  `cartethyia_memory_limit_bytes` (`src/observability/metrics.ts`, sampled by
  `RuntimeMetrics.sample()`).
- **`external`** — tracked through `trackMemoryUsage("external", …)` and returned by
  `performanceMetricsSnapshot().memory_bytes`
  (`src/observability/performance-metrics.ts`), surfaced on the console performance
  endpoint. This is the field that distinguishes the native floor from a real leak,
  and it is easy to overlook because it has no Prometheus gauge.
- **Leak-signal gauges that already exist** — `ipAbuseKeys` (fed by client-supplied
  identities, so its size *is* the leak signal), `quotaCacheEntries`,
  `routingRoundRobinEntries`, `proxy_in_flight`, `cartethyia_telemetry_buffered`.
- A memory-pressure monitor logs sustained high-water marks and proactively runs
  `Bun.gc(true)` while pressure persists (`src/observability/runtime-metrics.ts`).

## How to measure properly

1. Run `bun run src/main.ts` — **not** `bun run dev`.
2. Record the idle split. Expect `rss` ≈ 140 MB with `heapUsed` ≈ 24 MB.
3. Drive load, then record again. Judge by `heapUsed` and `external`, not `rss`.
4. For a JS-side leak, attach the inspector (`bun --inspect`) and take a heap
   snapshot; `Runtime.evaluate` on `process.memoryUsage()` gives the split without
   a snapshot and is usually enough to triage.

## Ruled out (with the evidence, so nobody re-litigates it)

| Suspect | Verdict |
|---|---|
| Unbounded caches | Ruled out. Every cache is bounded with LRU eviction — `authCache` (10 000, with a reverse index that is correctly unregistered on eviction), the quota `TtlCache` (1 024), `credCache`, `catalogCache`, the SSRF `dnsCache`, Antigravity's `projectIdCache`, and `byte-accounting` (10 000). |
| Metric label cardinality | Ruled out. Only `status` labels; no per-model, per-account, or per-request labels. |
| Missing SQLite pragmas | Ruled out — and worth stating because it looks missing on a careless read: `applyFilePragmas` sets `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout`, `cache_size=-8192` (8 MB), `temp_store=MEMORY`, and `wal_autocheckpoint`. |
| Prepared-statement churn | Ruled out. `sqliteSql()` inlines `now()`/`gen_random_uuid()` into the SQL text, producing a unique string per call, which defeats bun:sqlite's statement cache. Measured cost with `--expose-gc`: **3 MB per 200 000 prepares** (~15 bytes each). Negligible. Note that measuring this *without* `--expose-gc` shows ~23 MB per 200 k, which is uncollected garbage, not retention — the same trap as reading `rss` alone. |
| `sessionCache` / `inFlightHandshakes` (Xiaomi SSO) | **Was a real defect, now fixed.** The only maps in the gateway with no eviction at all: `sessionCache` was cleared only wholesale, and `inFlightHandshakes` only by each handshake's own `finally`. A rotating `passToken` added one entry per value and released none. Both are now bounded at 256 (`mimodesktop-sso.ts`). |

## Still open — the one thing that has not been measured

**Streaming.** Every measurement above is non-streaming, and streaming is where the
large buffers live: SSE decode, canonical-event accumulation, the 512 KB
client-transcript cap, provider capture, and concurrent in-flight streams. Under
sustained streaming load with high concurrency this is the only place a genuine leak
is still plausible, and it has not been exercised because no provider credential with
remaining quota was available while this was written.

Anyone picking this up should drive large **streamed** responses through the gateway
with a stub adapter (no provider quota needed) and watch `heapUsed`/`external` per
round. If those stay flat, there is no leak and the footprint is the native floor
described at the top of this file.
