// Drizzle-backed console persistence for network pools.
import { and, asc, eq, sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../../persistence/postgres";
import { networkPools, poolRoutingSettings } from "../../../persistence/schema";
import {
  DEFAULT_POOL_STRATEGY,
  type CreateNetworkPoolRequest,
  type HealthCheckResult,
  type NetworkPoolRecord,
  type NetworkPoolStore,
  type PoolSpeedTestResult,
  type PoolStrategySetting,
} from "./contracts";
import { classifyPoolConnectError, classifyPoolProbeResponse, parseEgressIp } from "./probe-result";
import { encryptCredential } from "../../../security/crypto";
import { createValidatedFetch } from "../../../network/outbound-fetch";
import {
  createHttpProxyAgent,
  createSocks5Agent,
  createBridgeAgent,
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
import { drainPoolByteDelta, recordPoolBytes } from "../../../network/pool/byte-accounting";
// Cloudflare's trace endpoint answers with plain `key=value` lines including
// `ip=`, the address the request egressed from. Dialing it THROUGH the pool
// therefore reports the pool's public address — which is what an operator
// means by "the proxy's IP" — rather than the local DNS answer for its
// hostname, which says nothing about where traffic actually leaves.
const NETWORK_POOL_HEALTH_CANARY = "https://www.cloudflare.com/cdn-cgi/trace";
// Fixed-size payload for throughput measurement. Cloudflare's speed endpoint
// streams exactly the requested byte count and answers no-cache, so the number
// reflects the tunnel rather than a CDN cache hit. The default (5 MB) finishes
// in a few seconds on a usable proxy and is large enough that TLS setup does
// not dominate; operators can ask for more when the link is fast enough that
// a short transfer measures ramp-up instead of throughput.
const NETWORK_POOL_SPEED_TEST_URL = "https://speed.cloudflare.com/__down?bytes=";
/** Worst-case wait for the largest allowed payload on a slow link. */
const NETWORK_POOL_SPEED_TEST_TIMEOUT_MS = 60_000;
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
      ...(row.egressIp ? { egressIp: row.egressIp } : {}),
      ...(row.quotaBytes !== null && row.quotaBytes !== undefined
        ? { quotaBytes: row.quotaBytes }
        : {}),
      ...(row.bytesSentTotal !== null && row.bytesSentTotal !== undefined
        ? { bytesSentTotal: row.bytesSentTotal }
        : {}),
      ...(row.bytesReceivedTotal !== null && row.bytesReceivedTotal !== undefined
        ? { bytesReceivedTotal: row.bytesReceivedTotal }
        : {}),
      ...(row.lastSpeedtestBytes !== null && row.lastSpeedtestBytes !== undefined
        ? { lastSpeedtestBytes: row.lastSpeedtestBytes }
        : {}),
      ...(row.lastSpeedtestDurationMs !== null && row.lastSpeedtestDurationMs !== undefined
        ? { lastSpeedtestDurationMs: row.lastSpeedtestDurationMs }
        : {}),
      ...(row.lastSpeedtestStatus === "ok" || row.lastSpeedtestStatus === "failed"
        ? { lastSpeedtestStatus: row.lastSpeedtestStatus }
        : {}),
      ...(row.lastSpeedtestError ? { lastSpeedtestError: row.lastSpeedtestError } : {}),
      ...(row.lastSpeedtestAt ? { lastSpeedtestAt: row.lastSpeedtestAt.toISOString() } : {}),
      ...(Object.keys(rest).length > 0 ? { config: rest } : {}),
      ...(row.credentialCiphertext ? { hasCredential: true } : {}),
      tenantId,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async dialPoolCanary(agent: PoolAgent): Promise<{ response: Response; latencyMs: number; egressIp?: string }> {
    const started = performance.now();
    const response = await createValidatedFetch({ agent })(NETWORK_POOL_HEALTH_CANARY, {
      method: "GET",
      signal: AbortSignal.timeout(8000),
    });
    const latencyMs = Math.round(performance.now() - started);
    // The body is tiny and already buffered by the time we read it; a failure
    // to read it must not turn a healthy probe into an error.
    let egressIp: string | undefined;
    try {
      const body = await response.clone().text();
      egressIp = parseEgressIp(body);
    } catch {
      egressIp = undefined;
    }
    return { response, latencyMs, ...(egressIp ? { egressIp } : {}) };
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
      ...(record.quotaBytes !== undefined ? { quotaBytes: record.quotaBytes } : {}),
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
        // An explicit `null` clears the quota (back to unmetered); omitting the
        // field leaves it as-is.
        ...("quotaBytes" in patch ? { quotaBytes: patch.quotaBytes ?? null } : {}),
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
      const { response, latencyMs, egressIp } = await this.dialPoolCanary(agent);
      result = classifyPoolProbeResponse(poolId, response, latencyMs);
      if (egressIp) result = { ...result, egressIp };
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
    // Metered bytes ride along in the same write: the probe does not add a
    // second UPDATE, it just banks whatever the sockets tallied since the
    // last pool-touching write.
    const now = new Date();
    const delta = drainPoolByteDelta(poolId);
    await this.db
      .update(networkPools)
      .set({
        lastHealthCheckAt: now,
        lastLatencyMs: result.latencyMs ?? null,
        // Keep the previous address when this probe could not read one.
        ...(result.egressIp ? { egressIp: result.egressIp } : {}),
        ...(delta.sent > 0 || delta.received > 0
          ? {
              bytesSentTotal: sql`${networkPools.bytesSentTotal} + ${delta.sent}`,
              bytesReceivedTotal: sql`${networkPools.bytesReceivedTotal} + ${delta.received}`,
            }
          : {}),
      })
      .where(and(eq(networkPools.tenantId, tenantId), eq(networkPools.id, poolId)));
    if (result.httpStatus !== undefined) {
      await disablePoolForProxyHttpStatus(this.db, poolId, result.httpStatus);
    }
    return result;
  }
  /**
   * Measures download throughput by streaming a fixed payload through the pool.
   *
   * The transfer runs through the same SSRF-validated agent dispatch uses, so
   * a measurement cannot be taken over a path production would refuse. The
   * whole payload is pulled into memory (5 MB) — bounded by the endpoint's
   * fixed size, not by what the peer chooses to send.
   */
  async speedTest(tenantId: string, poolId: string, bytes: number): Promise<PoolSpeedTestResult> {
    const rows = await this.db
      .select()
      .from(networkPools)
      .where(and(eq(networkPools.tenantId, tenantId), eq(networkPools.id, poolId)))
      .limit(1);
    if (!rows[0]) {
      return { poolId, status: "failed", bytes: 0, durationMs: 0, errorMessage: "Pool not found" };
    }
    // The measurement costs real bytes off the operator's proxy plan, so the
    // outcome is banked on the pool row (not only returned): the Proxy page
    // reads the last known throughput from the server after any reload.
    const persist = async (result: PoolSpeedTestResult): Promise<PoolSpeedTestResult> => {
      const measuredAt = new Date();
      const delta = drainPoolByteDelta(poolId);
      await this.db
        .update(networkPools)
        .set({
          lastSpeedtestBytes: result.status === "ok" ? result.bytes : 0,
          lastSpeedtestDurationMs: result.durationMs,
          lastSpeedtestStatus: result.status,
          lastSpeedtestError: result.errorMessage ?? null,
          lastSpeedtestAt: measuredAt,
          ...(delta.sent > 0 || delta.received > 0
            ? {
                bytesSentTotal: sql`${networkPools.bytesSentTotal} + ${delta.sent}`,
                bytesReceivedTotal: sql`${networkPools.bytesReceivedTotal} + ${delta.received}`,
              }
            : {}),
        })
        .where(and(eq(networkPools.tenantId, tenantId), eq(networkPools.id, poolId)));
      return { ...result, measuredAt: measuredAt.toISOString() };
    };
    let agent: PoolAgent;
    try {
      agent = await this.poolAgents.resolveAgent(poolId, tenantId);
    } catch (error) {
      return persist({
        poolId,
        status: "failed",
        bytes: 0,
        durationMs: 0,
        errorMessage: error instanceof Error ? error.message : "Failed to build pool agent",
      });
    }
    const started = performance.now();
    try {
      const response = await createValidatedFetch({ agent })(
        `${NETWORK_POOL_SPEED_TEST_URL}${bytes}`,
        { method: "GET", signal: AbortSignal.timeout(NETWORK_POOL_SPEED_TEST_TIMEOUT_MS) },
      );
      if (!response.ok) {
        return persist({
          poolId,
          status: "failed",
          bytes: 0,
          durationMs: Math.round(performance.now() - started),
          errorMessage: `HTTP ${response.status} from speed endpoint`,
        });
      }
      const payload = await response.arrayBuffer();
      // Stop the clock after the body is fully read: a stalled tail is part of
      // the throughput, so timing only the response headers would flatter a
      // slow tunnel.
      const durationMs = Math.round(performance.now() - started);
      const transferred = payload.byteLength;
      // The speed-test download itself is metered traffic through the pool, so
      // it is counted before banking: the quota bar must include the bytes the
      // measurement consumed.
      recordPoolBytes(poolId, "received", transferred);
      if (durationMs <= 0) return persist({ poolId, status: "ok", bytes: transferred, durationMs });
      const bytesPerSecond = transferred / (durationMs / 1000);
      return persist({
        poolId,
        status: "ok",
        bytes: transferred,
        durationMs,
        bytesPerSecond,
        megabitsPerSecond: (bytesPerSecond * 8) / 1_000_000,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Speed test failed";
      return persist({
        poolId,
        status: "failed",
        bytes: 0,
        durationMs: Math.round(performance.now() - started),
        errorMessage: message,
      });
    }
  }
  /**
   * Dials a public canary through an unsaved pool definition.
   *
   * Every `TransportKind` dials directly and gets a real end-to-end probe: an
   * http/https/socks5 pool tunnels to the canary, and a `bridge` pool dials the
   * bridge (CONNECT first, its header relay on refusal), so a passing probe
   * always means real traffic reached the canary through the configured egress.
   * (A former daemon-backed kind returned a fabricated `"healthy"` here because
   * its activation happened on save; with that flavor removed, a pass is real.)
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
          : request.kind === "bridge"
            ? createBridgeAgent(rawEndpoint, request.credential, this.ssrfPolicy)
            : createHttpProxyAgent(rawEndpoint, request.credential, this.ssrfPolicy);
      const { response, latencyMs, egressIp } = await this.dialPoolCanary(agent);
      const result = classifyPoolProbeResponse("adhoc", response, latencyMs);
      return egressIp ? { ...result, egressIp } : result;
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
