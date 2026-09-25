# Observability

Durable request telemetry, live console logs, Prometheus metrics, and opt-in payload capture. Everything here is metadata-first and best-effort: observability must never break, block, or leak through the request path.

## Layout

```
src/observability/
  logger.ts              # pino logger; every call also fans out to the log ring
  redaction.ts           # secret-key predicates + redactTelemetryValue
  log-ring.ts            # bounded in-memory console tail + pub/sub
  telemetry-buffer.ts    # TelemetryBatchBuffer: batched multi-row telemetry writer
  metrics.ts             # hand-rolled Prometheus registry (singleton `metrics`)
  runtime-metrics.ts     # periodic memory + collection-size sampler
  token-speed.ts         # shared tokens/sec computation
  performance-metrics.ts # bounded console performance snapshot
  payload-capture.ts     # opt-in redacted request/response capture (Postgres)
  payload-store.ts       # append-only .jsonb file frames backing payload rows
```

## Telemetry pipeline

One row per terminal request in `telemetry_events`, via `completeAttempt` (in
`transport/dispatch/attempt-finalize.ts`) -> `finalizeRequestTelemetry`
(`transport/middleware/ingress.ts`) -> `TelemetryBatchBuffer.enqueue` ->
batched `insertEvents` -> scheduled retention prune:

- `completeAttempt` runs capture + telemetry only for the terminal attempt
  (`completion.terminal`); intermediate failover attempts commit usage and
  report health but emit no row. A `state.completed` guard makes completion
  idempotent.
- `finalizeRequestTelemetry` skips non-proxy routes (e.g. `/v1/models`
  discovery), observes `proxy_request_latency_ms`, computes tokens/sec (see
  below), pushes a structured console line, and enqueues a
  `TelemetryEventInput`. With no authenticated tenant there is no valid row
  (`tenant_id` is NOT NULL), so only metrics + console fire.
- `registerTelemetryLifecycle` (`afterResponse`) is only the fallback
  finalizer for requests that never reached `completeAttempt` (early
  rejections). Streaming responses finalize on stream completion instead.
- `TelemetryBatchBuffer.enqueue` is non-blocking; a full buffer (default
  `maxItems` 10000, `maxBytes` bound, `maxBatch` 500) drops the event and
  counts it in `cartethyia_telemetry_dropped_total`. Flush cadence is adaptive
  (`adaptiveFlushIntervalMs`: idle polls at 4x interval, floor 50 ms under
  load) with a batch-full fast path. `drain` does one multi-row insert with 5
  exponential-backoff retries (25 ms -> 1000 ms), then opens an outage gate
  (`drainBlockedUntil`) and rate-limits the error log to one line per minute.
  `flush()` is idempotent and concurrent-safe; `stop({ flush: true })` is the
  shutdown safety net.
- The `telemetry-retention` scheduled task (every 6 h, registered in
  `runtime/dependencies.ts`) prunes metadata rows older than
  `CARTETHYIA_TELEMETRY_RETENTION_DAYS` (default 30 days) via
  `telemetryStore.pruneTelemetry`. Usage periods are therefore backed by
  retained metadata instead of silently shrinking at 3 days.
- Every row carries `error_origin` (`cartethyia`/`upstream`/`network`, from
  `GatewayError.origin`): the attempt loop records the failing error's origin
  (`attempt-loop.ts`), `completeAttempt` persists it, and the ingress fallback
  defaults to `cartethyia` when no GatewayError is present — so a failure reads
  as "ours" vs "theirs" without guessing from the category.

## Logger, redaction, log ring

- `logger.ts` exposes `log.debug/info/warn/error` on pino (pretty-printed in
  dev, JSON in production, level from `LOG_LEVEL`). Every call also appends to
  the console ring via a pre-pass: `decycle` (circular-safe, depth 5, Errors
  collapse to name + message) then `redactTelemetryValue`. The ring path is
  wrapped so it can never throw into the log call.
- `redaction.ts` is the canonical secret scrubber. `isSecretKeyName` matches
  credential/api_key/authorization/secret/password plus token names;
  `isOpaqueEncrypted` masks encrypted reasoning blobs; `redactTelemetryValue`
  redacts embedded `sk-`/`Bearer`/`rk_` shapes (whole string), credential-like
  prefixes, keeps only a 5-char `rk_` hint, and masks IPv4 literals. Redaction
  markers retain the `***REDACTED***` prefix and add `[credential]`,
  `[secret-key]`, `[encrypted]`, or `[ip]` so payload diagnosis can tell why
  a value is hidden without exposing the value. The module also exports
  `maskClientIp`, the read-path IP masker: IPv4 keeps its first three octets,
  IPv6 its first four hextets, an IPv4-mapped IPv6 address masks the embedded
  IPv4 tail, and an unparseable value becomes `***`. The console Usage/health
  store uses it to honor privacy mode without touching the stored row.
- `log-ring.ts` holds a 500-line in-memory tail (messages truncated at 2000
  chars) with snapshot + `subscribeConsoleLogs` fan-out consumed over SSE by
  the Console Log page. Structured lines carry `request_start` /
  `request_complete` / `request_error` / `token_refresh` metadata. In-memory by
  design: restarts clear the tail, and nothing here touches the database.

## Metrics, runtime sampler, token speed, performance snapshot

- `metrics.ts` is a dependency-free Prometheus text registry (singleton
  `metrics`, mirroring the `getDb`/`getRedis` pattern). Families: `cartethyia_pg_pool_*`
  (total/idle/waiting), `cartethyia_redis_up`, `proxy_requests_total{status}`,
  `proxy_admission_total{reason}`, `proxy_in_flight`,
  `proxy_request_latency_ms`, `cartethyia_telemetry_buffered` /
  `cartethyia_telemetry_dropped_total`, `cartethyia_memory_*`
  (rss/heap_used/heap_total/limit), `cartethyia_routing_roundrobin_entries{scope}`,
  `cartethyia_ip_abuse_keys`,
  `cartethyia_quota_cache_entries`, `cartethyia_pool_agent_entries`,
  `cartethyia_proxy_dial_dns_fallback_total`, `proxy_provider_adapter_load_ms`,
  `pool_cooldown_record_failed`, `quota_cache_invalidate_failed`,
  `version_discovery_failed{provider}`.
  Cardinality guards (`MAX_SERIES` 100, `MAX_LABELS` 8, value length 64) and
  `normalizeLabels` sanitization keep untrusted label values bounded.
- `RuntimeMetricsSampler.sample()` (driven by the `runtime-metrics` task every
  10 s) records `process.memoryUsage()` into the memory gauges and reads
  bounded-collection sizes through injected closures, so observability holds no
  references into routing/pool state. The memory limit resolves from
  `CARTETHYIA_MEMORY_LIMIT_BYTES`, else cgroup v2/v1 on Linux. Above 80% it
  optionally runs async `Bun.gc` and warns, each rate-limited to one per
  minute.
- `computeTokensPerSec` (shared by ingress telemetry and provider probes) is
  decode throughput: streaming requests with an observed token window report
  `output_tokens / (lastEvent - firstContent)`; everything else (non-streaming
  or degenerate windows) reports end-to-end `output_tokens / latency`, since
  upstream decode inside TTFT is unobservable and the naive subtraction
  produced absurd 7000+ tok/s rows. Returns `undefined` with no output tokens
  or no elapsed time.
- `performance-metrics.ts` complements Prometheus with a directly-inspectable
  console snapshot (`adapter_load_ms`, `model_catalog_load_ms`,
  `network_call_latency_ms`, `memory_bytes`). Each series is capped at 256
  entries and drops new keys when full.

## Payload capture

Opt-in, redacted, bounded, TTL'd request/response capture for debugging:

- Metadata in `telemetry_events` is always retained; payload bodies are off by
  default (`telemetryPayloads: "none"`). A tenant may explicitly choose
  `"bounded"` in Settings → Privacy for short-lived debugging capture.
- `isCaptureAllowed` requires exactly one opt-in flag matching the scope
  (`tenant` / `debug_session` / `operator_flag`); two flags at once refuse
  capture. The terminal-attempt path is additionally settings-gated.
- `buildPayloadRecord` redacts every body, drops bodies over 1 MB combined
  (replaced with a truncation marker), stamps a 15-minute expiry
  (`CARTETHYIA_TELEMETRY_PAYLOAD_RETENTION_MS`, clamped to 1 s..7 d), and links
  the row to `telemetry_events.request_id`.
- `payload-store.ts` persists frames as checksummed, length-prefixed JSON in
  append-only hourly `.jsonb` files (`CARTETHYIA_TELEMETRY_PAYLOAD_DIR`,
  1 MB max frame, `CARTETHYIA_TELEMETRY_PAYLOAD_FILE_MAX_BYTES` 64 MB max file
  with rotation, serialized writers); the DB
  row holds only a file reference. `cleanupExpired` (every 15 min via
  `telemetry-payload-cleanup`) deletes expired rows in batches and compacts
  the files. The file-store settings remain active because this backing store
  is still live.

## Rules / invariants

- `telemetry_events` is metadata-only; prompt/response bodies are structurally
  excluded from the schema and must never be added there.
- Telemetry/logging paths never block or throw into requests: enqueue is
  non-blocking, drains are counted when dropped, ring subscribers and the
  outage logger are failure-isolated.
- No secret material reaches logs, console lines, or payloads; all of them pass
  through `redactTelemetryValue`. Metrics labels are not redacted — they are
  bounded by `normalizeLabels` instead, so never put a secret in a label value.
- Metric and performance-series cardinality is capped; new labels or series
  keyed by untrusted input must go through the existing guards.
- Payload capture stays opt-in per scope, redacted, size-bounded, and short-TTL;
  widening any of these needs a deliberate, reviewed change.
