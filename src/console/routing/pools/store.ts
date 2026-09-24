// Drizzle-backed console persistence for network pools.
import { and, asc, eq } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../../persistence/postgres";
import { networkPools, poolRoutingSettings } from "../../../persistence/schema";
import {
  DEFAULT_POOL_STRATEGY,
  type CreateNetworkPoolRequest,
  type HealthCheckResult,
  type NetworkPoolRecord,
  type NetworkPoolStore,
  type PoolStrategySetting,
} from "./contracts";
import { classifyPoolConnectError, classifyPoolProbeResponse } from "./probe-result";
import { encryptCredential } from "../../../security/crypto";
import { createValidatedFetch } from "../../../network/outbound-fetch";
import {
  createHttpProxyAgent,
  createSocks5Agent,
  deriveKind,
  splitEndpointConfig,
  type PoolAgent,
} from "../../../network/pool/agent";
import { DrizzleNetworkPoolLoader } from "../../../network/pool/loader";
import { PoolAgentResolver } from "../../../network/pool/resolver";
import type { SsrfPolicy } from "../../../config";
import {
  disablePoolForProxyHttpStatus,
  listNetworkPoolHealthEvents,
  recoverNetworkPool,
} from "../../../network/pool-health-machine";
const NETWORK_POOL_HEALTH_CANARY = "https://www.google.com/generate_204";
/** Real Drizzle-backed network pool repository. */
export class DrizzleNetworkPoolStore implements NetworkPoolStore {
  /**
   * Shared pool-agent builder: validates the pool host against the SSRF policy
   * on every dial and applies the per-connect SOCKS5 revalidation, instead of
   * this store hand-rolling `createHttpProxyAgent`/`createSocks5Agent`.
   */
  private readonly poolAgents: PoolAgentResolver;

  constructor(
    private readonly db: CartethyiaDatabase,
    private readonly ssrfPolicy: SsrfPolicy = {},
  ) {
    this.poolAgents = new PoolAgentResolver(new DrizzleNetworkPoolLoader(db), { ssrfPolicy, db });
  }
  private map(row: typeof networkPools.$inferSelect, tenantId: string): NetworkPoolRecord {
    const raw = (row.endpointConfig ?? {}) as Record<string, unknown>;
    const { endpoint, label, rest } = splitEndpointConfig(raw);
    return {
      id: row.id,
      kind: deriveKind(row.kind, endpoint ?? ""),
      endpoint: endpoint ?? "",
      ...(label ? { label } : {}),
      maxInflight: row.maxInflight ?? 10,
      weight: row.weight ?? 100,
      status: row.status,
      inflight: 0,
      consecutiveFailures: row.consecutiveFailures,
      ...(row.lastSuccessAt ? { lastSuccessAt: row.lastSuccessAt.toISOString() } : {}),
      ...(row.lastLatencyMs !== null && row.lastLatencyMs !== undefined
        ? { lastLatencyMs: row.lastLatencyMs }
        : {}),
      ...(row.lastHealthCheckAt ? { lastHealthCheckAt: row.lastHealthCheckAt.toISOString() } : {}),
      ...(row.lastErrorAt ? { lastErrorAt: row.lastErrorAt.toISOString() } : {}),
      ...(row.lastError ? { lastError: row.lastError } : {}),
      ...(row.lastErrorCategory ? { lastErrorCategory: row.lastErrorCategory } : {}),
      ...(Object.keys(rest).length > 0 ? { config: rest } : {}),
      ...(row.credentialCiphertext ? { hasCredential: true } : {}),
      tenantId,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async dialPoolCanary(agent: PoolAgent): Promise<{ response: Response; latencyMs: number }> {
    const started = performance.now();
    const response = await createValidatedFetch({ agent })(NETWORK_POOL_HEALTH_CANARY, {
      method: "GET",
      signal: AbortSignal.timeout(8000),
    });
    return { response, latencyMs: Math.round(performance.now() - started) };
  }

  async list(tenantId: string): Promise<readonly NetworkPoolRecord[]> {
    const rows = await this.db
      .select()
      .from(networkPools)
      .where(eq(networkPools.tenantId, tenantId))
      .orderBy(asc(networkPools.createdAt), asc(networkPools.id));
    return rows.map((row) => this.map(row, tenantId));
  }

  async get(tenantId: string, poolId: string): Promise<NetworkPoolRecord | undefined> {
    const rows = await this.db
      .select()
      .from(networkPools)
      .where(and(eq(networkPools.tenantId, tenantId), eq(networkPools.id, poolId)))
      .limit(1);
    const row = rows[0];
    return row ? this.map(row, tenantId) : undefined;
  }

  async create(record: NetworkPoolRecord): Promise<void> {
    const kind = record.kind === "https" ? "http" : record.kind;
    await this.db.insert(networkPools).values({
      id: record.id,
      tenantId: record.tenantId,
      createdAt: new Date(record.createdAt),
      kind,
      endpointConfig: {
        endpoint: record.endpoint,
        ...(record.label ? { label: record.label } : {}),
        ...(record.config ?? {}),
      },
      ...(record.credential !== undefined
        ? { credentialCiphertext: encryptCredential(record.credential) }
        : {}),
      maxInflight: record.maxInflight,
      weight: record.weight,
      status: record.status,
      consecutiveFailures: 0,
    });
  }

  async update(
    tenantId: string,
    poolId: string,
    patch: Partial<NetworkPoolRecord>,
  ): Promise<NetworkPoolRecord | undefined> {
    const current = await this.get(tenantId, poolId);
    if (!current) return undefined;
    const endpointConfig: Record<string, unknown> = {
      endpoint: patch.endpoint ?? current.endpoint,
      ...((patch.label ?? current.label) ? { label: patch.label ?? current.label } : {}),
      ...(current.config ?? {}),
      ...(patch.config ?? {}),
    };
    const effectiveKind = patch.kind ?? current.kind;
    const clearsProxyResponseFailure =
      patch.status === "active" &&
      current.status === "disabled" &&
      (current.lastErrorCategory === "proxy_payment_required" ||
        current.lastErrorCategory === "proxy_auth_required");
    const rows = await this.db
      .update(networkPools)
      .set({
        endpointConfig,
        kind: effectiveKind === "https" ? "http" : effectiveKind,
        // Fields default to `undefined` when omitted from the patch; that
        // used to overwrite the current row with `undefined` and clobber
        // existing values. Fall back to the current record so a partial
        // PATCH truly leaves un-mentioned fields alone.
        maxInflight: patch.maxInflight ?? current.maxInflight,
        weight: patch.weight ?? current.weight,
        ...(clearsProxyResponseFailure
          ? {
              consecutiveFailures: 0,
              cooldownUntil: null,
              lastError: null,
              lastErrorCategory: null,
              lastErrorAt: null,
            }
          : {}),
        status: patch.status ?? current.status,
        ...(patch.credential !== undefined
          ? { credentialCiphertext: encryptCredential(patch.credential) }
          : {}),
      })
      .where(and(eq(networkPools.tenantId, tenantId), eq(networkPools.id, poolId)))
      .returning();
    const row = rows[0];
    return row ? this.map(row, tenantId) : undefined;
  }

  async delete(tenantId: string, poolId: string): Promise<boolean> {
    const rows = await this.db
      .delete(networkPools)
      .where(and(eq(networkPools.tenantId, tenantId), eq(networkPools.id, poolId)))
      .returning({ id: networkPools.id });
    return rows.length > 0;
  }

  async listHealthEvents(tenantId: string, poolId: string) {
    return listNetworkPoolHealthEvents(this.db, tenantId, poolId);
  }

  async recover(tenantId: string, poolId: string): Promise<boolean> {
    return recoverNetworkPool(this.db, tenantId, poolId);
  }
  async getStrategy(tenantId: string): Promise<PoolStrategySetting> {
    const rows = await this.db
      .select()
      .from(poolRoutingSettings)
      .where(eq(poolRoutingSettings.tenantId, tenantId))
      .limit(1);
    const row = rows[0];
    // No row = never configured = the default least-loaded scan.
    if (!row) return DEFAULT_POOL_STRATEGY;
    return { strategy: row.strategy, rotateCount: row.rotateCount };
  }

  async setStrategy(
    tenantId: string,
    setting: PoolStrategySetting,
  ): Promise<PoolStrategySetting> {
    await this.db
      .insert(poolRoutingSettings)
      .values({ tenantId, strategy: setting.strategy, rotateCount: setting.rotateCount })
      .onConflictDoUpdate({
        target: poolRoutingSettings.tenantId,
        set: { strategy: setting.strategy, rotateCount: setting.rotateCount },
      });
    return setting;
  }

  async healthCheck(tenantId: string, poolId: string): Promise<HealthCheckResult> {
    const rows = await this.db
      .select()
      .from(networkPools)
      .where(and(eq(networkPools.tenantId, tenantId), eq(networkPools.id, poolId)))
      .limit(1);
    const row = rows[0];
    if (!row) return { poolId, status: "unhealthy", errorMessage: "Pool not found" };
    // Resolve the pool's dispatch agent and dial a public canary THROUGH it.
    // This fixes the prior dual bug: `socks5://` endpoints were fed to
    // `createValidatedFetch` as a target URL (TypeError), and HTTP endpoints
    // were probed directly (listener reach, not end-to-end tunnel).
    let agent: PoolAgent;
    try {
      // Same builder dispatch uses, so the health check inherits the
      // per-connect SSRF revalidation instead of a second, weaker path.
      agent = await this.poolAgents.resolveAgent(poolId, tenantId);
    } catch (error) {
      return {
        poolId,
        status: "unhealthy",
        errorMessage: error instanceof Error ? error.message : "Failed to build pool agent",
      };
    }
    const started = performance.now();
    let result: HealthCheckResult;
    try {
      const { response, latencyMs } = await this.dialPoolCanary(agent);
      result = classifyPoolProbeResponse(poolId, response, latencyMs);
    } catch (error) {
      const latencyMs = Math.round(performance.now() - started);
      const proxyResponse = classifyPoolConnectError(poolId, error, latencyMs);
      if (proxyResponse) {
        result = proxyResponse;
      } else {
        // Only real timeouts are labeled "timeout" — anything else (refused,
        // reset, cert mismatch, CONNECT rejection) is "unhealthy".
        const message = error instanceof Error ? error.message : "Health check failed";
        const timedOut =
          (error instanceof Error && error.name === "AbortError") ||
          /timed out|timeout|ETIMEDOUT|EAI_AGAIN/i.test(message);
        result = {
          poolId,
          status: timedOut ? "timeout" : "unhealthy",
          latencyMs,
          errorMessage: message,
        };
      }
    }
    // Manual probes update check diagnostics, not dispatch-health state.
    const now = new Date();
    await this.db
      .update(networkPools)
      .set({
        lastHealthCheckAt: now,
        lastLatencyMs: result.latencyMs ?? null,
      })
      .where(and(eq(networkPools.tenantId, tenantId), eq(networkPools.id, poolId)));
    if (result.httpStatus !== undefined) {
      await disablePoolForProxyHttpStatus(this.db, poolId, result.httpStatus);
    }
    return result;
  }
  /**
   * Dials a public canary through an unsaved pool definition.
   *
   * `TransportKind` is exactly http/https/socks5, all of which dial directly,
   * so every kind gets a real end-to-end probe. (A former daemon-backed kind
   * returned a fabricated `"healthy"` here because its activation happened on
   * save; with that flavor removed, a passing probe always means a real
   * tunnel.)
   */
  async probeAdHoc(
    _tenantId: string,
    request: CreateNetworkPoolRequest,
  ): Promise<HealthCheckResult> {
    const started = performance.now();
    try {
      const rawEndpoint = request.endpoint.includes("://") ? request.endpoint : `${request.kind}://${request.endpoint}`;
      const agent =
        request.kind === "socks5"
          ? createSocks5Agent(rawEndpoint, request.credential, this.ssrfPolicy)
          : createHttpProxyAgent(rawEndpoint, request.credential, this.ssrfPolicy);
      const { response, latencyMs } = await this.dialPoolCanary(agent);
      return classifyPoolProbeResponse("adhoc", response, latencyMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Probe failed";
      return {
        poolId: "adhoc",
        status: "unhealthy",
        latencyMs: Math.round(performance.now() - started),
        errorMessage: message,
      };
    }
  }
}
