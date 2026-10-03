// Network-pool control-plane contracts: the request/response shapes, the
// store interface, and the shared validation every surface uses.
// Elysia-free on purpose: the dashboard imports these types, and `routes.ts`
// is the only module allowed to touch the HTTP layer.
import type { ConsoleAccessResolver } from "../../auth/access";
import type { AuditSink } from "../../domains/audit/contracts";
import { ConsoleDomainError } from "../../shared/errors";
import { isIP } from "node:net";
import { isAddressAllowed } from "../../../network/ssrf";
import { TRANSPORT_KINDS, type TransportKind } from "../../../network/pool/agent";
import type { SsrfPolicy } from "../../../config";
import type { NetworkPoolSelector } from "../../../network/pool/selector";
import type { PoolHealthEvent } from "../../../network/pool-health-machine";

export interface CreateNetworkPoolRequest {
  kind: TransportKind;
  label?: string;
  endpoint: string;
  credential?: string;
  quotaBytes?: number | null;
  maxInflight?: number;
  /** Routing weight across the pool group; defaults to 100. */
  weight?: number;
  /** Operators may enable/disable pools; health policy also disables them on proxy HTTP 402/407. */
  status?: "active" | "disabled";
  config?: Record<string, unknown>;
}
export interface NetworkPoolResponse {
  id: string;
  kind: TransportKind;
  label?: string;
  endpoint: string;
  maxInflight: number;
  weight: number;
  status: "active" | "cooldown" | "disabled";
  inflight: number;
  available?: number;
  utilization?: number;
  consecutiveFailures: number;
  lastSuccessAt?: string;
  lastLatencyMs?: number;
  lastHealthCheckAt?: string;
  lastErrorAt?: string;
  lastErrorCategory?: string;
  lastError?: string;
  cooldownUntil?: string;
  tenantId: string;
  /** Non-secret transport settings (e.g. timeout); never contains credential material. */
  config?: Record<string, unknown>;
  /** True when an encrypted credential is stored for this pool; never the credential itself. */
  hasCredential?: boolean;
  /** Public address the pool egresses from, as reported by the last successful
   * probe. Absent until the pool has been probed. */
  egressIp?: string;
  /** Operator-set egress allowance in bytes; absent when unmetered. */
  quotaBytes?: number;
  providerCooldowns?: Array<{ providerId: string; until: string; reason: string }>;
}


export interface NetworkPoolRecord extends NetworkPoolResponse {
  createdAt: string;
  /** Write-only: the store encrypts and persists this. Never rehydrated on read. */
  credential?: string;
}
export interface HealthCheckResult {
  poolId: string;
  status: "healthy" | "reachable" | "unhealthy" | "timeout";
  httpStatus?: 402 | 407;
  latencyMs?: number;
  errorMessage?: string;
  /** Public address the pool egressed from, when the probe could read one. */
  egressIp?: string;
}
/**
 * Throughput measured by dialing a fixed-size download through the pool.
 *
 * Distinct from `HealthCheckResult`: a health check asks "can this pool carry
 * traffic at all", a speed test asks "how fast". A pool can be perfectly
 * healthy and still measure a slow or failed transfer.
 */
export interface PoolSpeedTestResult {
  poolId: string;
  status: "ok" | "failed";
  /** Payload actually transferred, in bytes. */
  bytes: number;
  /** Wall-clock duration of the transfer, in milliseconds. */
  durationMs: number;
  /** Decimal (1 MB = 1_000_000) to match how operators read proxy plans. */
  bytesPerSecond?: number;
  megabitsPerSecond?: number;
  errorMessage?: string;
}
export function validateTransportConfig(
  kind: TransportKind,
  config: unknown,
): void {
  const cfg = config && typeof config === "object" ? (config as Record<string, unknown>) : {};
  switch (kind) {
    case "http":
    case "https":
      if (cfg.timeout !== undefined && typeof cfg.timeout !== "number")
        throw new ConsoleDomainError("invalid_config", 400, "HTTP timeout must be a number");
      return;
    case "socks5":
    case "bridge":
      return;
    default:
      // Compile-time exhaustiveness: new TransportKind variants must add a case.
      kind satisfies never;
      throw new ConsoleDomainError(
        "invalid_config",
        400,
        `Unsupported transport kind: ${String(kind)}`,
      );
  }
}

/**
 * Pool kinds and operator-settable statuses, as runtime tuples. `cooldown` is
 * health-machine-only and deliberately absent from the status tuple. The Elysia
 * body schema, the config validator, and the request types all project these
 * lists.
 */
export const POOL_KINDS = TRANSPORT_KINDS;
export const POOL_STATUSES = ["active", "disabled"] as const;

/** Operator-settable pool status. */
export type PoolStatus = (typeof POOL_STATUSES)[number];

/**
 * Pool-group selection strategies, as a runtime tuple: the Elysia body schema
 * projects its `t.Literal` union from it and the operations layer validates
 * direct callers against the same list (mirrors `POOL_STATUSES`). Values must
 * stay aligned with the `pool_routing_strategy` enum in `schema.ts`.
 */
export const POOL_ROUTING_STRATEGIES = ["least_loaded", "round_robin"] as const;
export type PoolRoutingStrategyValue = (typeof POOL_ROUTING_STRATEGIES)[number];

export interface PoolStrategySetting {
  strategy: PoolRoutingStrategyValue;
  /** Requests served by one pool before round robin advances (1..1000). */
  rotateCount: number;
}

/** No-row default: the weighted least-loaded scan that has always run. */
export const DEFAULT_POOL_STRATEGY: PoolStrategySetting = {
  strategy: "least_loaded",
  rotateCount: 1,
};

function requiredPoolString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new ConsoleDomainError("invalid_pool", 400, `Pool ${field} is required`);
  return value;
}

function requiredPoolNumber(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new ConsoleDomainError("invalid_pool", 400, `Pool ${field} must be a finite number`);
  return value;
}
/**
 * Strips secret-bearing keys from a pool's transport config before it is
 * echoed through the console API. HTTP(S)/SOCKS5 pools carry no credential
 * material, so this only guards rows written before binary pools were removed.
 */
const REDACTED_POOL_CONFIG_KEYS = new Set(["privateKey", "uuid"]);

/** Case-insensitive substring match for secret-bearing key shapes. */
function isSecretPoolKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.includes("secret") ||
    lower.includes("token") ||
    lower.includes("password") ||
    lower.includes("credential") ||
    lower.includes("apikey") ||
    lower.includes("api_key") ||
    lower.includes("auth")
  );
}

function sanitizePoolConfig(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([key]) => !REDACTED_POOL_CONFIG_KEYS.has(key) && !isSecretPoolKey(key),
  );
  return Object.fromEntries(entries);
}

/** Returns the request's transport config as the stored `endpoint_config` shape. */
export function normalizePoolConfig(config: unknown): Record<string, unknown> {
  return config && typeof config === "object" ? { ...(config as Record<string, unknown>) } : {};
}
export function sanitizePoolResponse(pool: unknown): NetworkPoolResponse {
  if (!pool || typeof pool !== "object")
    throw new ConsoleDomainError("invalid_pool", 400, "Pool must be an object");
  const p = pool as Record<string, unknown>;
  if (typeof p.kind !== "string" || !(POOL_KINDS as readonly string[]).includes(p.kind))
    throw new ConsoleDomainError("invalid_pool", 400, "Pool kind is required");
  if (typeof p.status !== "undefined" && !(POOL_STATUSES as readonly string[]).includes(p.status as string))
    throw new ConsoleDomainError("invalid_pool", 400, "Pool status is invalid");
  const maxInflight = requiredPoolNumber(p.maxInflight, "maxInflight", 10);
  const weight = requiredPoolNumber(p.weight, "weight", 100);
  const inflight = requiredPoolNumber(p.inflight, "inflight", 0);
  const consecutiveFailures = requiredPoolNumber(p.consecutiveFailures, "consecutiveFailures", 0);
  const config = sanitizePoolConfig(p.config);
  return {
    id: requiredPoolString(p.id, "id"),
    kind: p.kind as TransportKind,
    ...(typeof p.label === "string" && p.label.length > 0 ? { label: p.label } : {}),
    endpoint: requiredPoolString(p.endpoint, "endpoint"),
    maxInflight,
    weight,
    status: (p.status as NetworkPoolResponse["status"]) ?? "active",
    inflight,
    available: Math.max(0, maxInflight - inflight),
    utilization: maxInflight > 0 ? Math.min(1, inflight / maxInflight) : 1,
    consecutiveFailures,
    ...(typeof p.lastSuccessAt === "string" ? { lastSuccessAt: p.lastSuccessAt } : {}),
    ...(typeof p.lastLatencyMs === "number" && Number.isFinite(p.lastLatencyMs)
      ? { lastLatencyMs: p.lastLatencyMs }
      : {}),
    ...(typeof p.lastHealthCheckAt === "string" ? { lastHealthCheckAt: p.lastHealthCheckAt } : {}),
    ...(typeof p.lastErrorAt === "string" ? { lastErrorAt: p.lastErrorAt } : {}),
    ...(typeof p.lastErrorCategory === "string" ? { lastErrorCategory: p.lastErrorCategory } : {}),
    ...(typeof p.lastError === "string" ? { lastError: p.lastError } : {}),
    ...(typeof p.cooldownUntil === "string" ? { cooldownUntil: p.cooldownUntil } : {}),
    tenantId: requiredPoolString(p.tenantId, "tenantId"),
    ...(config ? { config } : {}),
    ...(p.hasCredential === true ? { hasCredential: true } : {}),
    // An observed address, not a secret: it is the pool's public egress.
    ...(typeof p.egressIp === "string" && isIP(p.egressIp) ? { egressIp: p.egressIp } : {}),
    ...(typeof p.quotaBytes === "number" && Number.isFinite(p.quotaBytes) && p.quotaBytes > 0
      ? { quotaBytes: p.quotaBytes }
      : {}),
  };
}
export interface NetworkPoolStore {
  list(tenantId: string): Promise<readonly NetworkPoolRecord[]>;
  get(tenantId: string, poolId: string): Promise<NetworkPoolRecord | undefined>;
  create(record: NetworkPoolRecord): Promise<void>;
  update(
    tenantId: string,
    poolId: string,
    patch: Partial<NetworkPoolRecord>,
  ): Promise<NetworkPoolRecord | undefined>;
  delete(tenantId: string, poolId: string): Promise<boolean>;
  healthCheck(tenantId: string, poolId: string): Promise<HealthCheckResult>;
  /** Measures download throughput through the pool; never throws for a slow
   * or refused transfer — a failed measurement is itself the result. */
  speedTest?(tenantId: string, poolId: string, bytes: number): Promise<PoolSpeedTestResult>;
  probeAdHoc?(
    tenantId: string,
    request: CreateNetworkPoolRequest,
  ): Promise<HealthCheckResult>;
  listHealthEvents(tenantId: string, poolId: string): Promise<readonly PoolHealthEvent[]>;
  recover(tenantId: string, poolId: string): Promise<boolean>;
  /** Per-tenant pool-group selection strategy; an absent row reads as
   * `DEFAULT_POOL_STRATEGY`. */
  getStrategy(tenantId: string): Promise<PoolStrategySetting>;
  /** Upserts the tenant's single settings row; returns the stored value. */
  setStrategy(tenantId: string, setting: PoolStrategySetting): Promise<PoolStrategySetting>;
}
/** One entry of a batch probe: the requested endpoint plus its outcome. */
export interface PoolBatchProbeResult {
  readonly endpoint: string;
  readonly kind: TransportKind;
  readonly result: HealthCheckResult;
}

/** How many proxy dials run at once during a batch probe. Shared by the
 * operations worker pool and the routes that expose the endpoint. */
export const POOL_BATCH_PROBE_CONCURRENCY = 10;

/** Upper bound on a single batch probe. Each entry dials an external host, so
 * the cap keeps one request from turning into an unbounded fan-out. */
export const MAX_BATCH_PROBE_TARGETS = 100;

export interface NetworkPoolAgentReleaser {
  releasePool(poolId: string, tenantId: string): Promise<void>;
}
export interface NetworkPoolConfig {
  readonly store: NetworkPoolStore;
  readonly accessResolver: ConsoleAccessResolver;
  /** Records privileged mutations to `admin_audit_log`; a no-op when omitted (e.g. tests). */
  readonly auditSink?: AuditSink;
  readonly poolSelector?: NetworkPoolSelector;
  readonly ssrfPolicy?: SsrfPolicy;
  /** Destroys the pool's cached dial agent/delegate subprocess on update,
   * disable, delete, and endpoint/credential rotation — otherwise the old
   * agent lingers for the rest
   * of the process lifetime after the pool's config has already changed. */
  readonly poolAgentReleaser?: NetworkPoolAgentReleaser;
  readonly snapshotInvalidator?: { invalidate(): Promise<number> };
  /**
   * SSRF-validated outbound fetch used by the hosted-relay deploy endpoint.
   * Deploy calls reach provider APIs (Cloudflare/Vercel/Deno), so they must be
   * checked like every other egress. Omitted in tests, where the deploy fetch
   * is stubbed through the operation itself.
   */
  readonly relayFetch?: (url: string, init: RequestInit) => Promise<Response>;

}

/** HTTP(S)/SOCKS5 pools dial `endpoint` directly, so it must be safe per SSRF policy. */
export function validateEndpoint(
  kind: TransportKind,
  endpoint: string,
  policy: SsrfPolicy = {},
): void {

  if (kind === "socks5") {
    const candidate = endpoint.includes("://") ? endpoint : `socks5://${endpoint}`;
    let u: URL;
    try {
      u = new URL(candidate);
    } catch {
      throw new ConsoleDomainError("invalid_endpoint", 400, "Endpoint must be host:port");
    }
    if (!u.hostname || !u.port)
      throw new ConsoleDomainError("invalid_endpoint", 400, "Endpoint must be host:port");
    if (u.hostname === "localhost" || u.hostname.endsWith(".internal"))
      throw new ConsoleDomainError("ssrf_rejected", 400, "Private endpoint rejected");
    if (isIP(u.hostname) !== 0 && !isAddressAllowed(u.hostname, policy))
      throw new ConsoleDomainError("ssrf_rejected", 400, "Private endpoint rejected");
    return;
  }
  if (kind === "bridge") {
    // A bridge endpoint is an http(s) front door; a bare host is read as https
    // because every hosted bridge (Railway/Vercel/Netlify/Deno) terminates TLS.
    // The port is not required — the front door's own default applies.
    let u: URL;
    try {
      u = new URL(endpoint.includes("://") ? endpoint : `https://${endpoint}`);
    } catch {
      throw new ConsoleDomainError("invalid_endpoint", 400, "Endpoint must be a bridge URL");
    }
    if (!["http:", "https:"].includes(u.protocol)) {
      throw new ConsoleDomainError("invalid_endpoint", 400, "Endpoint must be a bridge URL");
    }
    if (u.hostname === "localhost" || u.hostname.endsWith(".internal")) {
      throw new ConsoleDomainError("ssrf_rejected", 400, "Private endpoint rejected");
    }
    if (isIP(u.hostname) !== 0 && !isAddressAllowed(u.hostname, policy)) {
      throw new ConsoleDomainError("ssrf_rejected", 400, "Private endpoint rejected");
    }
    return;
  }
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    throw new ConsoleDomainError("invalid_endpoint", 400, "Endpoint must be a valid http(s) URL");
  }
  if (!["http:", "https:"].includes(u.protocol)) {
    throw new ConsoleDomainError("invalid_endpoint", 400, "Endpoint must be a valid http(s) URL");
  }
  if (u.hostname === "localhost" || u.hostname.endsWith(".internal")) {
    throw new ConsoleDomainError("ssrf_rejected", 400, "Private endpoint rejected");
  }
  if (isIP(u.hostname) !== 0 && !isAddressAllowed(u.hostname, policy)) {
    throw new ConsoleDomainError("ssrf_rejected", 400, "Private endpoint rejected");
  }
}
const MAX_POOL_INFLIGHT = 1_000_000;
const MAX_POOL_WEIGHT = 1_000;

export function validatePoolLimits(maxInflight?: number, weight?: number): void {
  if (
    maxInflight !== undefined &&
    (!Number.isInteger(maxInflight) || maxInflight < 1 || maxInflight > MAX_POOL_INFLIGHT)
  ) {
    throw new ConsoleDomainError(
      "invalid_pool_limits",
      400,
      "maxInflight must be an integer between 1 and 1000000",
    );
  }
  if (
    weight !== undefined &&
    (!Number.isInteger(weight) || weight < 1 || weight > MAX_POOL_WEIGHT)
  ) {
    throw new ConsoleDomainError(
      "invalid_pool_limits",
      400,
      "weight must be an integer between 1 and 1000",
    );
  }
}

