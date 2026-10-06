/**
 * Outbound network policy: trusted-proxy boundary, SSRF bounds, proxy agent
 * settings, and the process-wide resource bounds consumed by persistence and
 * telemetry.
 */

import { CONFIG_SPEC, readFlag, readInt, readList, readOptionalInt } from "./spec";

/**
 * How much of the inbound forwarding chain is trusted.
 *
 * - `disabled` — the raw TCP peer is the client; forwarded headers are ignored.
 * - `trusted` — the peer must match `allowlist` before its headers are read.
 * - `platform` — a PaaS edge that cannot be allowlisted. The edge terminates
 *   TLS and the container has no public address of its own, so every request
 *   arrives through it and the peer carries no information about the client.
 *   Opt-in only: a self-hosted deployment that exposes its own port must not
 *   select this, because then a direct caller could forge the headers.
 */
export type TrustedProxyMode = "disabled" | "trusted" | "platform";

/**
 * The one `TRUSTED_PROXY_CIDRS` value that selects `platform` mode instead of
 * naming CIDRs. It cannot be mistaken for an address, so the list form stays
 * unambiguous.
 */
export const TRUSTED_PROXY_PLATFORM_TOKEN = "platform";

/** Trusted reverse-proxy boundary used for forwarded client addresses. */
export interface TrustedProxyBoundary {
  readonly mode: TrustedProxyMode;
  readonly allowlist?: readonly string[];
}

/** Outbound SSRF policy shared by direct and provider-backed requests. */
export interface SsrfPolicy {
  readonly allowPrivate?: boolean;
  readonly allowedNetworks?: readonly string[];
  readonly maxRedirects?: number;
}

/** Resolves the trusted reverse-proxy allowlist without performing I/O. */
export function resolveTrustedProxyBoundary(): TrustedProxyBoundary {
  const allowlist = readList("TRUSTED_PROXY_CIDRS", CONFIG_SPEC.TRUSTED_PROXY_CIDRS);
  if (!allowlist) return { mode: "disabled" };
  // The platform token is checked case-insensitively and only when it is the
  // whole value: a list that also names CIDRs is a real allowlist, and reading
  // it as "trust everything" would silently widen the boundary.
  if (allowlist.length === 1 && allowlist[0]?.toLowerCase() === TRUSTED_PROXY_PLATFORM_TOKEN) {
    return { mode: "platform" };
  }
  return { mode: "trusted", allowlist };
}

/** Resolves one explicit outbound SSRF policy without performing I/O. */
export function resolveSsrfPolicy(): SsrfPolicy {
  const allowedNetworks = readList(
    "CARTETHYIA_ALLOWED_NETWORKS",
    CONFIG_SPEC.CARTETHYIA_ALLOWED_NETWORKS,
  );
  // `maxRedirects` is optional in the policy: an unset variable means "use the
  // egress default", which is distinct from an explicit `0`.
  const maxRedirects = readOptionalInt("CARTETHYIA_MAX_REDIRECTS", CONFIG_SPEC.CARTETHYIA_MAX_REDIRECTS);
  return {
    ...(readFlag("CARTETHYIA_ALLOW_PRIVATE_UPSTREAMS", CONFIG_SPEC.CARTETHYIA_ALLOW_PRIVATE_UPSTREAMS)
      ? { allowPrivate: true }
      : {}),
    ...(allowedNetworks ? { allowedNetworks } : {}),
    ...(maxRedirects === undefined ? {} : { maxRedirects }),
  };
}

// ─── Proxy pools ────────────────────────────────────────────────────────────

/** Per-pool keep-alive socket ceiling for proxy agents (default 100). */
export function resolveProxyMaxSockets(): number {
  return readInt("CARTETHYIA_PROXY_MAX_SOCKETS", CONFIG_SPEC.CARTETHYIA_PROXY_MAX_SOCKETS);
}

/** Per-pool idle keep-alive socket ceiling for proxy agents (default 20). */
export function resolveProxyMaxFreeSockets(): number {
  return readInt("CARTETHYIA_PROXY_MAX_FREE_SOCKETS", CONFIG_SPEC.CARTETHYIA_PROXY_MAX_FREE_SOCKETS);
}

// Proxy pool egress is dialed in-process by `network/pool/agent.ts` (http,
// https, socks5). The former child-process pool flavor — generated config
// files, a binary path, a local SOCKS port range, and a uid/gid drop — was
// removed with that feature; do not reintroduce its resolvers without the
// daemon that consumed them.

// ─── Process-wide resource bounds ───────────────────────────────────────────

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
