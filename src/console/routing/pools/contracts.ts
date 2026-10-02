import type { ConsoleAccessResolver } from "../../auth/access";
import type { AuditSink } from "../../domains/audit/contracts";
// Network-pool control-plane contracts and routes.
import { ConsoleDomainError, consoleErrorHandler, requireTenantScope } from "../../shared/errors";
import { Elysia, t } from "elysia";
import { isIP } from "node:net";
import type { AccessDecision } from "../../../security/access-control";
import { isAddressAllowed } from "../../../network/ssrf";
import { TRANSPORT_KINDS, type TransportKind } from "../../../network/pool/agent";
import type { SsrfPolicy } from "../../../config";
import type { NetworkPoolSelector } from "../../../network/pool/selector";
import type { PoolHealthEvent } from "../../../network/pool-health-machine";
import { literalUnion } from "../../shared/elysia-schema";
import {
  deployRelay as deployRelayWorker,
  isRelayTarget,
  RELAY_TARGETS,
  type RelayDeployRequest,
} from "./relay-deploy";
import { SPEED_TEST_DEFAULT_BYTES, SPEED_TEST_MAX_BYTES, SPEED_TEST_MIN_BYTES } from "./speed-test-sizes";
export {
  SPEED_TEST_DEFAULT_BYTES,
  SPEED_TEST_MAX_BYTES,
  SPEED_TEST_MIN_BYTES,
} from "./speed-test-sizes";

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
function normalizePoolConfig(config: unknown): Record<string, unknown> {
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
function validateEndpoint(
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

function validatePoolLimits(maxInflight?: number, weight?: number): void {
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

export function createNetworkPoolOperations(config: NetworkPoolConfig) {
  const operations = {
    async listPools(access: AccessDecision | undefined): Promise<NetworkPoolResponse[]> {
        const a = requireTenantScope(access, "dashboard:read");
        const rawPools = await config.store.list(a.tenantId);
        return Promise.all(
          rawPools.map(async (r) => {
            const res = sanitizePoolResponse(r);
            const cooldowns = await config.poolSelector?.getPoolCooldowns(r.id);
            const inflight = config.poolSelector
              ? await config.poolSelector.getInflightAuthoritative(r.id)
              : res.inflight;
            return {
              ...res,
              inflight,
              available: Math.max(0, res.maxInflight - inflight),
              utilization: res.maxInflight > 0 ? Math.min(1, inflight / res.maxInflight) : 1,
              ...(cooldowns && cooldowns.length > 0
                ? {
                    providerCooldowns: cooldowns.map((c) => ({
                      providerId: c.providerId,
                      until: new Date(c.until).toISOString(),
                      reason: c.reason,
                    })),
                  }
                : {}),
            };
          }),
        );
      },
    async getPoolDetail(
        access: AccessDecision | undefined,
        poolId: string,
      ): Promise<NetworkPoolResponse> {
        const a = requireTenantScope(access, "dashboard:read");
        const rec = await config.store.get(a.tenantId, poolId);
        if (!rec) throw new ConsoleDomainError("pool_not_found", 404, `Pool ${poolId} not found`);
        const res = sanitizePoolResponse(rec);
        const cooldowns = await config.poolSelector?.getPoolCooldowns(poolId);
        const inflight = config.poolSelector
          ? await config.poolSelector.getInflightAuthoritative(poolId)
          : res.inflight;
        return {
          ...res,
          inflight,
          available: Math.max(0, res.maxInflight - inflight),
          utilization: res.maxInflight > 0 ? Math.min(1, inflight / res.maxInflight) : 1,
          ...(cooldowns && cooldowns.length > 0
            ? {
                providerCooldowns: cooldowns.map((c) => ({
                  providerId: c.providerId,
                  until: new Date(c.until).toISOString(),
                  reason: c.reason,
                })),
              }
            : {}),
        };
      },
    async clearPoolCooldown(
        access: AccessDecision | undefined,
        poolId: string,
        providerId?: string,
      ): Promise<{ success: boolean }> {
        requireTenantScope(access, "dashboard:write");
        if (providerId) {
          await config.poolSelector?.clearProviderCooldown(poolId, providerId);
        } else {
          const active = await config.poolSelector?.getPoolCooldowns(poolId);
          if (active) {
            for (const c of active) {
              await config.poolSelector?.clearProviderCooldown(poolId, c.providerId);
            }
          }
        }
        return { success: true };
      },
    async getStrategy(access: AccessDecision | undefined): Promise<PoolStrategySetting> {
        const a = requireTenantScope(access, "dashboard:read");
        return config.store.getStrategy(a.tenantId);
      },
    async updateStrategy(
        access: AccessDecision | undefined,
        request: Partial<PoolStrategySetting>,
      ): Promise<PoolStrategySetting> {
        const a = requireTenantScope(access, "dashboard:write");
        const current = await config.store.getStrategy(a.tenantId);
        const strategy = request.strategy ?? current.strategy;
        // Runtime check despite the type: the HTTP body is cast at the route
        // boundary, so a hand-crafted request can carry any string here.
        if (!POOL_ROUTING_STRATEGIES.includes(strategy)) {
          throw new ConsoleDomainError("invalid_pool", 400, "Pool strategy is invalid");
        }
        const rotateCount = request.rotateCount ?? current.rotateCount;
        if (!Number.isInteger(rotateCount) || rotateCount < 1 || rotateCount > 1000) {
          throw new ConsoleDomainError(
            "invalid_pool_limits",
            400,
            "rotateCount must be an integer between 1 and 1000",
          );
        }
        const saved = await config.store.setStrategy(a.tenantId, { strategy, rotateCount });
        await config.auditSink?.record({
          access: a,
          action: "network_pool.strategy_updated",
          target: a.tenantId,
          detail: { strategy: saved.strategy, rotateCount: saved.rotateCount },
        });
        await config.snapshotInvalidator?.invalidate();
        return saved;
      },
    async createPool(
        access: AccessDecision | undefined,
        request: CreateNetworkPoolRequest,
      ): Promise<NetworkPoolResponse> {
        const a = requireTenantScope(access, "dashboard:write");
        const normalizedConfig = normalizePoolConfig(request.config);
        validateEndpoint(request.kind, request.endpoint, config.ssrfPolicy);
        validateTransportConfig(request.kind, normalizedConfig);
        validatePoolLimits(request.maxInflight, request.weight);
        const record: NetworkPoolRecord = {
          id: crypto.randomUUID(),
          kind: request.kind,
          endpoint: request.endpoint,
          maxInflight: request.maxInflight ?? 10,
          weight: request.weight ?? 100,
          status: "active",
          inflight: 0,
          consecutiveFailures: 0,
          tenantId: a.tenantId,
          createdAt: new Date().toISOString(),
          ...(request.label === undefined ? {} : { label: request.label }),
          ...(Object.keys(normalizedConfig).length > 0 ? { config: normalizedConfig } : {}),
          ...(request.credential === undefined ? {} : { credential: request.credential }),
          ...(request.credential !== undefined ? { hasCredential: true } : {}),
          // Absent or `null` both mean unmetered; a positive number is the
          // allowance. The body schema already rejects zero and negatives.
          ...(typeof request.quotaBytes === "number" ? { quotaBytes: request.quotaBytes } : {}),
        };
        await config.store.create(record);
        await config.auditSink?.record({
          access: a,
          action: "network_pool.created",
          target: record.id,
          detail: { kind: record.kind, hasCredential: record.hasCredential === true },
        });
        await config.snapshotInvalidator?.invalidate();
        return sanitizePoolResponse(record);
      },
    async updatePool(
        access: AccessDecision | undefined,
        poolId: string,
        request: Partial<CreateNetworkPoolRequest>,
      ): Promise<NetworkPoolResponse> {
        const a = requireTenantScope(access, "dashboard:write");
        validatePoolLimits(request.maxInflight, request.weight);
        if (
          request.endpoint !== undefined ||
          request.kind !== undefined ||
          request.config !== undefined
        ) {
          const existing = await config.store.get(a.tenantId, poolId);
          if (!existing) throw new ConsoleDomainError("pool_not_found", 404, `Pool ${poolId} not found`);
          const effectiveKind = request.kind ?? existing.kind;
          const effectiveEndpoint = request.endpoint ?? existing.endpoint;
          const mergedConfig = { ...(existing.config ?? {}), ...(request.config ?? {}) };
          const normalizedConfig = normalizePoolConfig(mergedConfig);
          validateEndpoint(effectiveKind, effectiveEndpoint, config.ssrfPolicy);
          validateTransportConfig(effectiveKind, normalizedConfig);
          request = { ...request, config: normalizedConfig };
        }
        const updated = await config.store.update(
          a.tenantId,
          poolId,
          request as Partial<NetworkPoolRecord>,
        );
        if (!updated) throw new ConsoleDomainError("pool_not_found", 404, `Pool ${poolId} not found`);
        // Any mutation can invalidate the cached dial agent (endpoint, credential,
        // kind, config, or a disable via status) — release unconditionally so the
        // next dispatch rebuilds against the fresh row rather than reusing a
        // stale agent/delegate bound to the pre-update configuration.
        await config.poolAgentReleaser?.releasePool(poolId, a.tenantId);
        await config.auditSink?.record({
          access: a,
          action: "network_pool.updated",
          target: poolId,
          detail: { fields: Object.keys(request) },
        });
        await config.snapshotInvalidator?.invalidate();
        return sanitizePoolResponse(updated);
      },
    async deletePool(
        access: AccessDecision | undefined,
        poolId: string,
      ): Promise<{ success: boolean }> {
        const a = requireTenantScope(access, "dashboard:write");
        const ok = await config.store.delete(a.tenantId, poolId);
        if (!ok) throw new ConsoleDomainError("pool_not_found", 404, `Pool ${poolId} not found`);
        await config.poolAgentReleaser?.releasePool(poolId, a.tenantId);
        // Drop the pool's cooldown markers and their index set with it. Without
        // this the Redis keys outlive the row, so a pool later reusing the id
        // inherits cooldowns it never earned — and the index set, which has no
        // TTL of its own, would keep listing them.
        await config.poolSelector?.clearPoolCooldowns(poolId);
        await config.auditSink?.record({
          access: a,
          action: "network_pool.deleted",
          target: poolId,
        });
        await config.snapshotInvalidator?.invalidate();
        return { success: true };
      },
    async listPoolHealthEvents(
      access: AccessDecision | undefined,
      poolId: string,
    ): Promise<readonly PoolHealthEvent[]> {
      const a = requireTenantScope(access, "dashboard:read");
      return config.store.listHealthEvents(a.tenantId, poolId);
    },
    async recoverPool(
      access: AccessDecision | undefined,
      poolId: string,
    ): Promise<{ success: true }> {
      const a = requireTenantScope(access, "dashboard:write");
      const recovered = await config.store.recover(a.tenantId, poolId);
      if (!recovered) throw new ConsoleDomainError("pool_not_found", 404, `Pool ${poolId} not found`);
      await config.poolAgentReleaser?.releasePool(poolId, a.tenantId);
      await config.auditSink?.record({
        access: a,
        action: "network_pool.recovered",
        target: poolId,
      });
      await config.snapshotInvalidator?.invalidate();
      return { success: true };
    },
    async healthCheck(
        access: AccessDecision | undefined,
        poolId: string,
      ): Promise<HealthCheckResult> {
        const a = requireTenantScope(access, "dashboard:read");
        const result = await config.store.healthCheck(a.tenantId, poolId);
        if (result.httpStatus !== undefined) {
          await config.poolAgentReleaser?.releasePool(poolId, a.tenantId);
          await config.snapshotInvalidator?.invalidate();
        }
        return result;
      },
    /**
     * Measures download throughput through one saved pool.
     *
     * Read-scoped like the health check: it dials the tenant's own pool and
     * changes no state. A pool that cannot be dialed reports `failed` rather
     * than throwing, so a batch of these returns a per-pool verdict.
     */
    async speedTest(
      access: AccessDecision | undefined,
      poolId: string,
      bytes: number,
    ): Promise<PoolSpeedTestResult> {
      const a = requireTenantScope(access, "dashboard:read");
      if (!config.store.speedTest) {
        throw new ConsoleDomainError("not_supported", 400, "Speed tests are unavailable");
      }
      if (!Number.isInteger(bytes) || bytes < SPEED_TEST_MIN_BYTES || bytes > SPEED_TEST_MAX_BYTES) {
        throw new ConsoleDomainError(
          "invalid_speed_test_size",
          422,
          `Payload must be between ${SPEED_TEST_MIN_BYTES} and ${SPEED_TEST_MAX_BYTES} bytes`,
        );
      }
      return config.store.speedTest(a.tenantId, poolId, bytes);
    },
    async probeAdHocPool(
      access: AccessDecision | undefined,
      request: CreateNetworkPoolRequest,
    ): Promise<HealthCheckResult> {
      const a = requireTenantScope(access, "dashboard:read");
      if (config.store.probeAdHoc) {
        return config.store.probeAdHoc(a.tenantId, request);
      }
      throw new ConsoleDomainError("not_supported", 400, "Ad-hoc pool probing is unavailable");
    },
    /**
     * Probes many unsaved pool definitions in one call.
     *
     * The dashboard tests a pasted list before saving it; doing that one
     * request per proxy made a 100-line paste take a minute. The dials still
     * happen individually — only the round-trips are batched — and run with
     * bounded concurrency so a large list does not open every socket at once.
     */
    async probeAdHocPoolBatch(
      access: AccessDecision | undefined,
      requests: readonly CreateNetworkPoolRequest[],
    ): Promise<readonly PoolBatchProbeResult[]> {
      const a = requireTenantScope(access, "dashboard:read");
      if (requests.length === 0) return [];
      if (requests.length > MAX_BATCH_PROBE_TARGETS) {
        throw new ConsoleDomainError(
          "batch_too_large",
          422,
          `At most ${MAX_BATCH_PROBE_TARGETS} targets per batch`,
        );
      }
      if (!config.store.probeAdHoc) {
        throw new ConsoleDomainError("not_supported", 400, "Ad-hoc pool probing is unavailable");
      }
      const probe = config.store.probeAdHoc.bind(config.store);
      const results: PoolBatchProbeResult[] = new Array(requests.length);
      let cursor = 0;
      const worker = async () => {
        while (cursor < requests.length) {
          const index = cursor++;
          const request = requests[index]!;
          // A single failing probe must not fail the batch: the caller wants a
          // per-endpoint verdict, so an error becomes that endpoint's result.
          let result: HealthCheckResult;
          try {
            result = await probe(a.tenantId, request);
          } catch (error) {
            result = {
              poolId: request.endpoint,
              status: "unhealthy",
              errorMessage: error instanceof Error ? error.message : "Probe failed",
            };
          }
          results[index] = { endpoint: request.endpoint, kind: request.kind, result };
        }
      };
      const workers = Array.from(
        { length: Math.min(POOL_BATCH_PROBE_CONCURRENCY, requests.length) },
        () => worker(),
      );
      await Promise.all(workers);
      return results;
    },
    /**
     * Deploys a hosted relay (Cloudflare/Vercel/Deno) and registers its URL as
     * an active HTTP pool. The provider API token is used for the deploy and
     * never persisted; the relay URL is a public host, which is what the pool
     * stores. The deploy fetch is the SSRF-validated one, so the provider API
     * call is checked like every other egress.
     */
    async deployRelay(
      access: AccessDecision | undefined,
      request: RelayDeployRequest,
    ): Promise<NetworkPoolResponse & { relayUrl: string }> {
      const a = requireTenantScope(access, "dashboard:write");
      if (!config.relayFetch)
        throw new ConsoleDomainError("not_supported", 503, "Relay deployment is unavailable");
      if (!isRelayTarget(request.target))
        throw new ConsoleDomainError("invalid_request", 422, `Unsupported relay target: ${String(request.target)}`);
      const result = await deployRelayWorker(config.relayFetch, request);
      const created = await operations.createPool(access, {
        kind: "http",
        endpoint: result.relayUrl,
        label: request.projectName?.trim() || `${result.target} relay`,
      });
      await config.auditSink?.record({
        access: a,
        action: "network_pool.relay_deployed",
        target: created.id,
        detail: { target: result.target, relayUrl: result.relayUrl },
      });
      return { ...created, relayUrl: result.relayUrl };
    },
  };
  return operations;
}

const poolKindSchema = literalUnion(POOL_KINDS);
const createPoolBody = t.Object({
  kind: poolKindSchema,
  label: t.Optional(t.String()),
  endpoint: t.String(),
  credential: t.Optional(t.String()),
  maxInflight: t.Optional(t.Number()),
  weight: t.Optional(t.Number()),
  status: t.Optional(literalUnion(POOL_STATUSES)),
  config: t.Optional(t.Record(t.String(), t.Unknown())),
  /** Egress allowance in bytes; `null` clears it back to unmetered. */
  quotaBytes: t.Optional(t.Union([t.Number({ minimum: 1 }), t.Null()])),
});

/** How many proxy dials run at once during a batch probe. */
const POOL_BATCH_PROBE_CONCURRENCY = 10;

const deployRelayBody = t.Object({
  target: literalUnion(RELAY_TARGETS),
  token: t.String({ minLength: 1 }),
  accountId: t.Optional(t.String()),
  projectName: t.Optional(t.String()),
});

const testBatchBody = t.Object({
  targets: t.Array(createPoolBody, { minItems: 1, maxItems: MAX_BATCH_PROBE_TARGETS }),
});
const updatePoolBody = t.Partial(createPoolBody);

export function createNetworkPoolRoutes(config: NetworkPoolConfig): Elysia {
  const factory = createNetworkPoolOperations(config);
  return new Elysia({ prefix: "/network/pools" })
    .error(consoleErrorHandler("Network pool operation failed"))
    .get("/", async ({ request }) => {
      return await factory.listPools(config.accessResolver(request));
})
    .get("/:poolId", async ({ request, params }) => {
      return await factory.getPoolDetail(config.accessResolver(request), params.poolId);
})
    .post("/", { body: createPoolBody }, async ({ request, body, set }) => {
      set.status = 201;
      return await factory.createPool(
        config.accessResolver(request),
        body as CreateNetworkPoolRequest,
      );
})


    .patch("/:poolId", { body: updatePoolBody }, async ({ request, params, body }) => {
      return await factory.updatePool(
        config.accessResolver(request),
        params.poolId,
        body as Partial<CreateNetworkPoolRequest>,
      );
})
    .delete("/:poolId", async ({ request, params }) => {
      return await factory.deletePool(config.accessResolver(request), params.poolId);
})
    .get("/:poolId/health-events", async ({ request, params }) => {
      return await factory.listPoolHealthEvents(config.accessResolver(request), params.poolId);
})
    .post("/:poolId/recover", async ({ request, params }) => {
      return await factory.recoverPool(config.accessResolver(request), params.poolId);
})
    .post("/:poolId/health-check", async ({ request, params }) => {
      return await factory.healthCheck(config.accessResolver(request), params.poolId);
})
    .post(
      "/:poolId/speed-test",
      { body: t.Optional(t.Object({ bytes: t.Optional(t.Number()) })) },
      async ({ request, params, body }) => {
        return await factory.speedTest(
          config.accessResolver(request),
          params.poolId,
          body?.bytes ?? SPEED_TEST_DEFAULT_BYTES,
        );
      },
    )
    .post("/test", { body: createPoolBody }, async ({ request, body }) => {
      return await factory.probeAdHocPool(
        config.accessResolver(request),
        body as CreateNetworkPoolRequest,
      );
})
    .post("/test-batch", { body: testBatchBody }, async ({ request, body }) => {
      return await factory.probeAdHocPoolBatch(
        config.accessResolver(request),
        body.targets as CreateNetworkPoolRequest[],
      );
})
    .post(
      "/:poolId/cooldowns/clear",
      { body: t.Optional(t.Object({ providerId: t.Optional(t.String()) })) },
      async ({ request, params, body }) => {
        return await factory.clearPoolCooldown(
          config.accessResolver(request),
          params.poolId,
          body?.providerId,
        );
},
    )
    .post("/relay/deploy", { body: deployRelayBody }, async ({ request, body }) => {
      return await factory.deployRelay(config.accessResolver(request), body as RelayDeployRequest);
    })
    .get("/strategy", async ({ request }) => {
      return await factory.getStrategy(config.accessResolver(request));
})
    .patch(
      "/strategy",
      {
        body: t.Object({
          strategy: t.Optional(literalUnion(POOL_ROUTING_STRATEGIES)),
          rotateCount: t.Optional(t.Number()),
        }),
      },
      async ({ request, body }) => {
        return await factory.updateStrategy(
          config.accessResolver(request),
          body as Partial<PoolStrategySetting>,
        );
},
    ) as unknown as Elysia;
}
