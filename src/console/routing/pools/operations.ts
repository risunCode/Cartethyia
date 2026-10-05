// Network-pool control-plane operations: the store-backed mutations and reads
// behind the routes. Depends only on the contracts and the shared helpers;
// `routes.ts` is the only HTTP surface.
import { ConsoleDomainError, requireTenantScope } from "../../shared/errors";
import type { PoolHealthEvent } from "../../../network/pool-health-machine";
import type { AccessDecision } from "../../../security/access-control";
import {
  deployRelay as deployRelayWorker,
  isRelayTarget,
  type RelayDeployRequest,
} from "./relay-deploy";
import { SPEED_TEST_MAX_BYTES, SPEED_TEST_MIN_BYTES } from "./speed-test-sizes";
import { normalizeBridgeEndpoint } from "../../../network/pool/agent";
import {
  MAX_BATCH_PROBE_TARGETS,
  POOL_BATCH_PROBE_CONCURRENCY,
  POOL_ROUTING_STRATEGIES,
  normalizePoolConfig,
  sanitizePoolResponse,
  validateEndpoint,
  validatePoolLimits,
  validateTransportConfig,
  type CreateNetworkPoolRequest,
  type HealthCheckResult,
  type NetworkPoolConfig,
  type NetworkPoolRecord,
  type NetworkPoolResponse,
  type PoolBatchProbeResult,
  type PoolSpeedTestResult,
  type PoolStrategySetting,
} from "./contracts";

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
        // The `bridge://` marker is an input convention, not a transport: fold
        // it to the http(s) URL the pool dials once, here, so what is stored and
        // validated is exactly what the loader hands the agent factory.
        const endpoint =
          request.kind === "bridge" ? normalizeBridgeEndpoint(request.endpoint) : request.endpoint;
        validateEndpoint(request.kind, endpoint, config.ssrfPolicy);
        validateTransportConfig(request.kind, normalizedConfig);
        validatePoolLimits(request.maxInflight, request.weight);
        const record: NetworkPoolRecord = {
          id: crypto.randomUUID(),
          kind: request.kind,
          endpoint,
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
          const rawEndpoint = request.endpoint ?? existing.endpoint;
          const effectiveEndpoint =
            effectiveKind === "bridge" ? normalizeBridgeEndpoint(rawEndpoint) : rawEndpoint;
          const mergedConfig = { ...(existing.config ?? {}), ...(request.config ?? {}) };
          const normalizedConfig = normalizePoolConfig(mergedConfig);
          validateEndpoint(effectiveKind, effectiveEndpoint, config.ssrfPolicy);
          validateTransportConfig(effectiveKind, normalizedConfig);
          request = { ...request, endpoint: effectiveEndpoint, config: normalizedConfig };
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
