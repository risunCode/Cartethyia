/**
 * Upstream request timeout, stream watchdog, and retry-backoff resolvers,
 * plus the derived distributed-inflight TTL they feed.
 */

import { CONFIG_SPEC, readInt, readOptionalInt } from "./spec";

/**
 * Explicit process memory limit in bytes; unset means auto-detect (cgroups).
 * `resolveMemoryLimitBytes` in `observability/runtime-metrics.ts` falls back to
 * the cgroup limit when this is absent.
 */
export function resolveMemoryLimitOverrideBytes(): number | undefined {
  return readOptionalInt("CARTETHYIA_MEMORY_LIMIT_BYTES", CONFIG_SPEC.CARTETHYIA_MEMORY_LIMIT_BYTES);
}

/**
 * Wall-clock bound for one proxied request, from ingress to the terminal
 * upstream event, including candidate failover and retry backoff. Defaults to
 * 120s. For a streaming response it bounds the pre-stream phase only: once the
 * body is established the deadline is re-armed to this value plus the stream
 * stall budget, so the stream watchdogs govern body duration while the request
 * keeps a hard ceiling.
 */
export function resolveUpstreamTimeoutMs(): number {
  return readInt("CARTETHYIA_UPSTREAM_TIMEOUT_MS", CONFIG_SPEC.CARTETHYIA_UPSTREAM_TIMEOUT_MS);
}

/**
 * Max silence between upstream stream events before the stream is declared
 * stalled and aborted with 504. Defaults to 360s: above every legitimate long
 * reasoning silence (Codex/o1-style hidden reasoning can hold silence for
 * minutes). The pool-slot crash-recovery TTL is derived from this value plus
 * the request deadline, so the watchdog always releases the lease before the
 * sweep could reclaim it.
 */
export function resolveStreamStallTimeoutMs(): number {
  return readInt(
    "CARTETHYIA_STREAM_STALL_TIMEOUT_MS",
    CONFIG_SPEC.CARTETHYIA_STREAM_STALL_TIMEOUT_MS,
  );
}

/**
 * Crash-recovery TTL, in seconds, for a distributed inflight slot.
 *
 * The normal release path decrements the key immediately, so this TTL only
 * matters when a holder dies mid-request. It must therefore exceed the longest
 * legitimate slot hold — the pre-stream request deadline plus the
 * post-establishment stream stall budget — or a long healthy request expires
 * its own key mid-flight and lets admission exceed the configured cap. The
 * fixed buffer covers pre-stream retries and clock skew.
 *
 * Derived from the same two resolvers the dispatch path uses, so raising either
 * timeout keeps the invariant. Shared by the routing admission controller and
 * the network-pool selector: both hold a slot for the same request duration, so
 * a shorter TTL in either one reintroduces the over-admission the other avoids.
 */
export function resolveInflightTtlSeconds(): number {
  return (
    Math.ceil((resolveUpstreamTimeoutMs() + resolveStreamStallTimeoutMs()) / 1000) +
    INFLIGHT_TTL_BUFFER_SECONDS
  );
}

/**
 * Slack added to the derived inflight TTL: covers pre-stream retries and clock
 * skew between the instance that armed the key and the one that reads it.
 */
const INFLIGHT_TTL_BUFFER_SECONDS = 120;

/**
 * Max time from dispatch to the first client-visible stream chunk (TTFB).
 * Defaults to 200s; once the first chunk is enqueued the longer stall bound
 * applies, so a provider that is actively reasoning is not cut short.
 */
export function resolveStreamFirstChunkTimeoutMs(): number {
  return readInt(
    "CARTETHYIA_STREAM_FIRST_CHUNK_TIMEOUT_MS",
    CONFIG_SPEC.CARTETHYIA_STREAM_FIRST_CHUNK_TIMEOUT_MS,
  );
}

/** Base delay for candidate-failover backoff (full-jitter exponential). Default 100ms. */
export function resolveFallbackRetryBaseMs(): number {
  return readInt("CARTETHYIA_FALLBACK_RETRY_BASE_MS", CONFIG_SPEC.CARTETHYIA_FALLBACK_RETRY_BASE_MS);
}

/** Cap for candidate-failover backoff. Default 2000ms. */
export function resolveFallbackRetryCapMs(): number {
  return readInt("CARTETHYIA_FALLBACK_RETRY_CAP_MS", CONFIG_SPEC.CARTETHYIA_FALLBACK_RETRY_CAP_MS);
}

/** Per-request upper bound on candidate dispatch attempts. Default 8. */
export function resolveRouteMaxAttempts(): number {
  return readInt("CARTETHYIA_ROUTE_MAX_ATTEMPTS", CONFIG_SPEC.CARTETHYIA_ROUTE_MAX_ATTEMPTS);
}
