import { loadavg, cpus, totalmem } from "node:os";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import type { RedisClient } from "../../persistence/redis";
import { apiKeys, networkPools, telemetryPayloads } from "../../persistence/schema";
import {
  queryTelemetryEvents,
  type TelemetryEventRecord,
} from "../../observability/event-log";
import { isGatewayError } from "../../observability/telemetry-status";
import { decodeDatedCursor, encodeCursor } from "../../console/shared/cursor";
import { CARTETHYIA_VERSION } from "../../version";
import { CachedPreferencesReader, DrizzlePreferencesReader, type PreferencesReader } from "../../persistence/tenant-preferences";
import type {
  ObservabilityStore,
  UsageDimension,
  SystemHealthResponse,
  TelemetryEventView,
  TelemetryEventDetail,
  TelemetryEventListPage,
  UsageByResponse,
  UsageCacheResponse,
  UsageChartBucket,
  UsageChartResponse,
  UsageRequestDetail,
  UsageRequestItem,
  UsageRequestsResponse,
  UsageResponse,
  UsageSummaryResponse,
} from "./contracts";
import { maskClientIp } from "../../observability/redaction";
import { splitEndpointConfig } from "../../network/pool/agent";
import { resolveDbMode } from "../../persistence/db-mode";
import { payloadReferenceFromRow, readPayloadFrame } from "../../observability/payload-store";
import { shouldMaskClientIp } from "../shared/ip-privacy";

function mapTelemetryEventRow(event: TelemetryEventRecord): TelemetryEventView {
  return {
    id: event.id,
    createdAt: event.createdAt,
    tenantId: event.tenantId ?? "",
    requestId: event.requestId,
    ...(event.sourceSurface ? { sourceSurface: event.sourceSurface } : {}),
    ...(event.requestedModel ? { requestedModel: event.requestedModel } : {}),
    ...(event.providerId ? { providerId: event.providerId } : {}),
    ...(event.latencyMs !== null ? { latencyMs: event.latencyMs ?? undefined } : {}),
    ...(event.status ? { status: event.status } : {}),
    ...(event.inputTokens !== null ? { inputTokens: event.inputTokens ?? undefined } : {}),
    ...(event.outputTokens !== null ? { outputTokens: event.outputTokens ?? undefined } : {}),
    ...(event.estimatedCostUsd !== null
      ? { estimatedCost: Number(event.estimatedCostUsd ?? 0) }
      : {}),
    ...(event.tokensPerSec !== null ? { tokensPerSec: Number(event.tokensPerSec) } : {}),
    ...(event.firstContentDeltaAtMs !== null ? { firstContentDeltaAtMs: event.firstContentDeltaAtMs } : {}),
    ...(event.lastEventAtMs !== null ? { lastEventAtMs: event.lastEventAtMs } : {}),
  };
}
/** The HTTP status a row renders as when the wire status was never recorded. */
function effectiveHttpStatus(event: TelemetryEventRecord): number {
  if (event.httpStatus !== null) return event.httpStatus;
  if (event.status === "completed") return 200;
  if (event.status === "cancelled") return 499;
  if (event.status === "truncated") return 502;
  return 500;
}

/**
 * Opaque, monotonic (createdAt, id) cursor. `createdAt` alone is not unique
 * — two telemetry events in the same millisecond would silently skip one
 * row across pages — so we tie-break on id and encode both, matching
 * `DrizzleAuditReadStore`'s cursor.
 */

/** Resolves a `usage` period token ("24h", "7d", "30d", "all") to its inclusive start date. */
function periodStartDate(period: string): Date | undefined {
  const match = /^(\d+)([hd])$/.exec(period);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unitMs = match[2] === "h" ? 3_600_000 : 86_400_000;
  return new Date(Date.now() - amount * unitMs);
}


/**
 * Client identity straight from the stored `User-Agent`: the first RFC 9110
 * product token carries both the client and its version (`bun/1.2.3`,
 * `codex-cli/0.1.0`), so no prefix catalog can drift from what the client
 * actually sent. Browser agents start with the historical `Mozilla/5.0`
 * token, which names no real client, so they report as `Browser`.
 */
export function clientNameFromUserAgent(userAgent: string | null | undefined): string {
  const raw = userAgent?.trim();
  if (!raw) return "unknown";
  if (/^mozilla\//i.test(raw)) return "Browser";
  const product = raw.split(/\s+/, 1)[0] ?? "";
  const slash = product.indexOf("/");
  const token = slash <= 0 ? product : product.slice(0, slash + 1).concat(product.slice(slash + 1).split(/[;,)]/, 1)[0] ?? "");
  return token || "unknown";
}
/** Time-series bucket width for the usage chart, chosen from the window length. */
function chartBucketSeconds(period: string): number {
  const since = periodStartDate(period);
  if (!since) return 86_400;
  const windowMs = Date.now() - since.getTime();
  if (windowMs <= 2 * 3_600_000) return 300;
  if (windowMs <= 2 * 86_400_000) return 3_600;
  if (windowMs <= 10 * 86_400_000) return 21_600;
  return 86_400;
}

/**
 * The model id with the client's requested reasoning effort as a display
 * suffix — only when the request actually carried one.
 */
function modelWithEffort(event: TelemetryEventRecord): string | undefined {
  const model = event.requestedModel;
  if (!model) return undefined;
  return event.requestedEffort ? `${model} (${event.requestedEffort})` : model;
}

function mapUsageRequestItem(
  event: TelemetryEventRecord,
  hideClientIp: boolean,
): UsageRequestItem {
  const input = event.inputTokens ?? 0;
  const output = event.outputTokens ?? 0;
  return {
    requestId: event.requestId,
    ...(event.sourceSurface ? { surface: event.sourceSurface } : {}),
    ...(event.providerId ? { providerId: event.providerId } : {}),
    ...(event.accountId ? { accountId: event.accountId } : {}),
    ...(modelWithEffort(event) === undefined ? {} : { model: modelWithEffort(event) as string }),
    status: event.status ?? "unknown",
    ...(event.errorCategory ? { errorKind: event.errorCategory } : {}),
    ...(event.errorOrigin ? { errorOrigin: event.errorOrigin } : {}),
    httpStatus: effectiveHttpStatus(event),
    mode: event.stream ? "stream" : "non_stream",
    startedAt: event.createdAt,
    ...(event.latencyMs !== null ? { durationMs: event.latencyMs ?? undefined } : {}),
    ...(event.inputTokens !== null ? { inputTokens: event.inputTokens ?? undefined } : {}),
    ...(event.outputTokens !== null ? { outputTokens: event.outputTokens ?? undefined } : {}),
    ...(event.cachedInputTokens !== null
      ? { cachedTokens: event.cachedInputTokens ?? undefined }
      : {}),
    ...(event.reasoningTokens !== null
      ? { reasoningTokens: event.reasoningTokens ?? undefined }
      : {}),
    ...(event.endpoint ? { endpoint: event.endpoint } : {}),
    ...(event.apiKeyId ? { apiKeyId: event.apiKeyId } : {}),
    ...(event.userAgent ? { userAgent: event.userAgent } : {}),
    ...(event.userAgent ? { clientName: clientNameFromUserAgent(event.userAgent) } : {}),
    ...(event.clientIp
      ? { clientIp: hideClientIp ? maskClientIp(event.clientIp) : event.clientIp }
      : {}),
    ...(input + output > 0 ? { totalTokens: input + output } : {}),
    ...(event.ttfbMs !== null ? { ttfbMs: event.ttfbMs ?? undefined } : {}),
    ...(event.tokensPerSec !== null ? { tokensPerSec: Number(event.tokensPerSec) } : {}),
    ...(event.firstContentDeltaAtMs !== null ? { firstContentDeltaAtMs: event.firstContentDeltaAtMs } : {}),
    ...(event.lastEventAtMs !== null ? { lastEventAtMs: event.lastEventAtMs } : {}),
    ...(event.estimatedCostUsd !== null && event.estimatedCostUsd !== undefined
      ? { estimatedCost: Number(event.estimatedCostUsd) }
      : {}),
    ...(event.creditUsed !== null && event.creditUsed !== undefined
      ? { creditUsed: Number(event.creditUsed) }
      : {}),
    ...(event.resolveMs !== null && event.resolveMs !== undefined
      ? { resolveMs: event.resolveMs }
      : {}),
  };
}
async function resolveProxyLabel(
  db: CartethyiaDatabase,
  tenantId: string,
  poolId: string,
): Promise<string> {
  const rows = await db
    .select({ id: networkPools.id, endpointConfig: networkPools.endpointConfig })
    .from(networkPools)
    .where(and(eq(networkPools.id, poolId), eq(networkPools.tenantId, tenantId)))
    .limit(1);
  const row = rows[0];
  if (!row) return `${poolId.slice(0, 8)}…`;
  const { endpoint, label } = splitEndpointConfig((row.endpointConfig ?? {}) as Record<string, unknown>);
  return label ?? endpoint ?? `${poolId.slice(0, 8)}…`;
}
const HEALTH_WINDOW_MS = 24 * 3_600_000;
const TOP_N = 50;

/** Nearest-rank percentile over a sorted array, matching `percentile_cont` closely enough for a health gauge. */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return Math.round(sorted[index] ?? 0);
}

/** The largest entries of a count map, capped. */
function topCounts(counts: ReadonlyMap<string, number>, limit: number): Array<[string, number]> {
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

/** The grouping value for one usage breakdown dimension. */
function dimensionName(dimension: UsageDimension, event: TelemetryEventRecord): string | null {
  if (dimension === "model") return event.requestedModel;
  if (dimension === "key") return event.apiKeyId;
  if (dimension === "client") return event.userAgent;
  if (dimension === "client_ip") return event.clientIp;
  return event.providerId;
}

interface BreakdownBucket {
  name: string;
  requests: number;
  input: number;
  output: number;
  cached: number;
  errors: number;
  cost: number | null;
  rateSum: number;
  rateCount: number;
}

function emptyBreakdown(name: string): BreakdownBucket {
  return { name, requests: 0, input: 0, output: 0, cached: 0, errors: 0, cost: null, rateSum: 0, rateCount: 0 };
}

/** Real Drizzle-backed observability repository used by the production console. */
export class DrizzleObservabilityStore implements ObservabilityStore {
  constructor(
    private readonly db: CartethyiaDatabase,
    private readonly redis: RedisClient | undefined,
    /**
     * Tenant preferences, revision-cached. The Usage page reads the privacy
     * gate on the list, detail and breakdown paths, so a direct SELECT here
     * re-read the same row per request; the cache collapses that.
     */
    private readonly preferences: PreferencesReader = new CachedPreferencesReader(
      new DrizzlePreferencesReader(db),
    ),
  ) {}

  async health(tenantId: string): Promise<SystemHealthResponse> {
    return this.computeHealth(tenantId);
  }

  private async computeHealth(tenantId: string): Promise<SystemHealthResponse> {
    const memory = process.memoryUsage();
    const cpuPercent = Math.round((loadavg()[0]! / Math.max(cpus().length, 1)) * 10000) / 100;

    let databaseHealthy = true;
    let total = 0;
    let errors = 0;
    let avg = 0;
    let p95 = 0;
    let p99 = 0;
    let cacheHitRate = 0;
    let avgTokensPerSec = 0;
    try {
      // Bounded 24h rolling window (matches the Overview copy). The file is the
      // source, so the percentiles are computed over the retained events.
      const since = new Date(Date.now() - HEALTH_WINDOW_MS);
      const events = await queryTelemetryEvents({ tenantId, since });
      const latencies: number[] = [];
      let latencySum = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let tokensPerSecSum = 0;
      let tokensPerSecCount = 0;
      for (const event of events) {
        total += 1;
        if (isGatewayError(event.status, event.httpStatus)) errors += 1;
        if (event.latencyMs !== null) {
          latencies.push(event.latencyMs);
          latencySum += event.latencyMs;
        }
        if (event.cachedInputTokens !== null) {
          inputTokens += event.inputTokens ?? 0;
          outputTokens += event.outputTokens ?? 0;
        }
        if (event.tokensPerSec !== null) {
          tokensPerSecSum += event.tokensPerSec;
          tokensPerSecCount += 1;
        }
      }
      latencies.sort((a, b) => a - b);
      avg = latencies.length > 0 ? Math.round(latencySum / latencies.length) : 0;
      p95 = percentile(latencies, 0.95);
      p99 = percentile(latencies, 0.99);
      // Prompt share of all tokens: the operator-facing cache column now
      // leads with input, so a cached/input ratio would read a constant 100%.
      const tokenTotal = inputTokens + outputTokens;
      cacheHitRate = tokenTotal > 0 ? Math.round((inputTokens / tokenTotal) * 10000) / 100 : 0;
      avgTokensPerSec = tokensPerSecCount > 0 ? tokensPerSecSum / tokensPerSecCount : 0;
    } catch {
      databaseHealthy = false;
    }

    // No client means the memory backend, which is healthy by construction.
    let redisHealthy = this.redis === undefined;
    if (this.redis !== undefined) {
      try {
        redisHealthy = (await this.redis.ping()) === "PONG";
      } catch {
        redisHealthy = false;
      }
    }

    const status: SystemHealthResponse["status"] = !databaseHealthy
      ? "unhealthy"
      : !redisHealthy
        ? "degraded"
        : "healthy";

    return {
      version: process.env.CARTETHYIA_VERSION ?? CARTETHYIA_VERSION,
      status,
      uptime_seconds: Math.floor(process.uptime()),
      database_healthy: databaseHealthy,
      redis_healthy: redisHealthy,
      memory_bytes: memory.rss,
      memory_percent: Math.round((memory.rss / Math.max(totalmem(), 1)) * 10000) / 100,
      // Reported so the console can explain a large RSS instead of leaving the
      // operator to read it as the gateway alone. In lite mode this process
      // hosts the database too, so the resident set covers both.
      database_in_process: resolveDbMode() === "lite",
      cpu_percent: cpuPercent,
      cpu_cores: cpus().length,
      pid: process.pid,
      platform: `Bun ${Bun.version} · ${process.platform}`,
      request_count: total,
      error_count: errors,
      latency_avg_ms: avg,
      latency_p95_ms: p95,
      latency_p99_ms: p99,
      cache_hit_rate_percent: cacheHitRate,
      avg_tokens_per_sec: avgTokensPerSec,
    };
  }
  async usage(tenantId: string, period: string): Promise<UsageResponse> {
    return this.computeUsage(tenantId, period);
  }

  private async computeUsage(tenantId: string, period: string): Promise<UsageResponse> {
    const events = await this.periodEvents(tenantId, period);
    let requestsTotal = 0;
    let requestsSucceeded = 0;
    let requestsFailed = 0;
    let tokensUsed = 0;
    let estimatedCost = 0;
    const models = new Map<string, number>();
    const providers = new Map<string, number>();
    for (const event of events) {
      requestsTotal += 1;
      if (event.status === "completed") requestsSucceeded += 1;
      if (isGatewayError(event.status, event.httpStatus)) requestsFailed += 1;
      tokensUsed += (event.inputTokens ?? 0) + (event.outputTokens ?? 0);
      estimatedCost += event.estimatedCostUsd ?? 0;
      if (event.requestedModel) models.set(event.requestedModel, (models.get(event.requestedModel) ?? 0) + 1);
      if (event.providerId) providers.set(event.providerId, (providers.get(event.providerId) ?? 0) + 1);
    }
    return {
      tenantId,
      period,
      requestsTotal,
      requestsSucceeded,
      requestsFailed,
      tokensUsed,
      estimatedCost,
      topModels: topCounts(models, TOP_N).map(([modelId, count]) => ({ modelId, count })),
      topProviders: topCounts(providers, TOP_N).map(([providerId, count]) => ({ providerId, count })),
    };
  }

  /** The tenant's retained events inside a usage period. `all` keeps everything. */
  private periodEvents(tenantId: string, period: string): Promise<readonly TelemetryEventRecord[]> {
    const since = periodStartDate(period);
    return queryTelemetryEvents(since === undefined ? { tenantId } : { tenantId, since });
  }

  async usageSummary(tenantId: string, period: string): Promise<UsageSummaryResponse> {
    const events = await this.periodEvents(tenantId, period);
    let requests = 0;
    let inputTokens = 0;
    let cachedTokens = 0;
    let outputTokens = 0;
    let errors = 0;
    let cancelled = 0;
    let truncated = 0;
    let latencySum = 0;
    let latencyCount = 0;
    let estimatedCostUsd = 0;
    let unpriced = 0;
    let tokensPerSecSum = 0;
    let tokensPerSecCount = 0;
    const statuses = new Map<number, number>();
    for (const event of events) {
      requests += 1;
      inputTokens += event.inputTokens ?? 0;
      cachedTokens += event.cachedInputTokens ?? 0;
      outputTokens += event.outputTokens ?? 0;
      if (isGatewayError(event.status, event.httpStatus)) errors += 1;
      if (event.status === "cancelled") cancelled += 1;
      if (event.status === "truncated") truncated += 1;
      if (event.latencyMs !== null) {
        latencySum += event.latencyMs;
        latencyCount += 1;
      }
      if (event.estimatedCostUsd !== null) estimatedCostUsd += event.estimatedCostUsd;
      else if (event.status === "completed") unpriced += 1;
      if (event.tokensPerSec !== null) {
        tokensPerSecSum += event.tokensPerSec;
        tokensPerSecCount += 1;
      }
      const status = effectiveHttpStatus(event);
      statuses.set(status, (statuses.get(status) ?? 0) + 1);
    }
    return {
      period,
      totals: {
        statusCounts: [...statuses].sort(([a], [b]) => a - b).map(([status, count]) => ({ status, count })),
        requests,
        inputTokens,
        cachedTokens,
        outputTokens,
        errors,
        cancelled,
        truncated,
        avgDurationMs: latencyCount > 0 ? latencySum / latencyCount : 0,
        estimatedCostUsd,
        partial: unpriced > 0,
        cacheHitRate: inputTokens > 0 ? (cachedTokens / inputTokens) * 100 : 0,
        avgTokensPerSec: tokensPerSecCount > 0 ? tokensPerSecSum / tokensPerSecCount : 0,
      },
    };
  }

  async usageChart(tenantId: string, period: string): Promise<UsageChartResponse> {
    const since = periodStartDate(period);
    const bucketSeconds = chartBucketSeconds(period);
    const stepMs = bucketSeconds * 1000;
    const events = await this.periodEvents(tenantId, period);
    const byTime = new Map<number, UsageChartBucket>();
    for (const event of events) {
      const at = new Date(event.createdAt).getTime();
      if (!Number.isFinite(at)) continue;
      const start = Math.floor(at / stepMs) * stepMs;
      const bucket = byTime.get(start) ?? { t: new Date(start).toISOString(), requests: 0, input: 0, cached: 0, output: 0 };
      bucket.requests += 1;
      bucket.input += event.inputTokens ?? 0;
      bucket.cached += event.cachedInputTokens ?? 0;
      bucket.output += event.outputTokens ?? 0;
      byTime.set(start, bucket);
    }
    const rows = [...byTime.keys()];
    const first = rows.length > 0 ? Math.min(...byTime.keys()) : undefined;
    const startMs = since ? since.getTime() : first;
    if (startMs === undefined) return { buckets: [] };
    const aligned = Math.floor(startMs / stepMs) * stepMs;
    const buckets: UsageChartBucket[] = [];
    for (let at = aligned; at <= Date.now(); at += stepMs) {
      buckets.push(
        byTime.get(at) ?? { t: new Date(at).toISOString(), requests: 0, input: 0, cached: 0, output: 0 },
      );
    }
    return { buckets };
  }

  async usageBy(
    tenantId: string,
    dimension: UsageDimension,
    period: string,
  ): Promise<UsageByResponse> {
    const events = await this.periodEvents(tenantId, period);
    const groups = new Map<string, BreakdownBucket>();
    for (const event of events) {
      const raw = dimensionName(dimension, event);
      if (raw === null || raw.length === 0) continue;
      const name = dimension === "client" ? clientNameFromUserAgent(raw) : raw;
      const bucket = groups.get(name) ?? emptyBreakdown(name);
      bucket.requests += 1;
      bucket.input += event.inputTokens ?? 0;
      bucket.output += event.outputTokens ?? 0;
      bucket.cached += event.cachedInputTokens ?? 0;
      if (isGatewayError(event.status, event.httpStatus)) bucket.errors += 1;
      if (event.estimatedCostUsd !== null) bucket.cost = (bucket.cost ?? 0) + event.estimatedCostUsd;
      if (event.tokensPerSec !== null) {
        bucket.rateSum += event.tokensPerSec;
        bucket.rateCount += 1;
      }
      groups.set(name, bucket);
    }
    const mapped = [...groups.values()]
      .map((bucket) => ({
        name: bucket.name,
        requests: bucket.requests,
        input: bucket.input,
        output: bucket.output,
        cached: bucket.cached,
        total: bucket.input + bucket.output,
        errors: bucket.errors,
        costUsd: bucket.cost,
        cacheHitRate:
          bucket.input + bucket.output > 0 ? (bucket.input / (bucket.input + bucket.output)) * 100 : 0,
        avgTokensPerSec: bucket.rateCount > 0 ? bucket.rateSum / bucket.rateCount : 0,
      }))
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 100);
    if (dimension === "client_ip") {
      // Same fail-closed gate as the request list: storage keeps the raw
      // address, only presentation masks it.
      const hideClientIp = await shouldMaskClientIp(this.preferences, tenantId);
      if (!hideClientIp) return { rows: mapped };
      // Grouping happened on the raw address, so masking can collapse distinct
      // hosts into one display name (`203.0.113.7` and `203.0.113.9` both become
      // `203.0.113.xxx`). Re-aggregate by the masked name: two rows the operator
      // cannot tell apart are one row, and the totals must not be understated.
      const merged = new Map<string, (typeof mapped)[number]>();
      for (const row of mapped) {
        const masked = maskClientIp(row.name);
        const existing = merged.get(masked);
        if (existing === undefined) {
          merged.set(masked, { ...row, name: masked });
          continue;
        }
        const input = existing.input + row.input;
        const output = existing.output + row.output;
        merged.set(masked, {
          ...existing,
          requests: existing.requests + row.requests,
          input,
          output,
          cached: existing.cached + row.cached,
          total: input + output,
          errors: existing.errors + row.errors,
          costUsd:
            existing.costUsd === null && row.costUsd === null
              ? null
              : (existing.costUsd ?? 0) + (row.costUsd ?? 0),
          cacheHitRate: input + output > 0 ? (input / (input + output)) * 100 : 0,
        });
      }
      return {
        rows: [...merged.values()].sort((a, b) => b.requests - a.requests),
      };
    }
    if (dimension !== "key") return { rows: mapped };
    const ids = [...new Set(mapped.map((row) => row.name))];
    const labels = ids.length > 0 ? await this.apiKeyLabels(tenantId, ids) : new Map<string, string>();
    return {
      rows: mapped.map((row) => {
        const label = labels.get(row.name);
        return label === undefined ? row : { ...row, label };
      }),
    };
  }

  private async apiKeyLabels(tenantId: string, ids: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map<string, string>();
    const keyRows = await this.db
      .select({ id: apiKeys.id, label: apiKeys.label })
      .from(apiKeys)
      .where(and(inArray(apiKeys.id, [...unique]), eq(apiKeys.tenantId, tenantId)));
    return new Map(keyRows.map((keyRow) => [keyRow.id, keyRow.label] as const));
  }

  async usageCache(tenantId: string, period: string): Promise<UsageCacheResponse> {
    const events = await this.periodEvents(tenantId, period);
    let inputTokens = 0;
    let cachedTokens = 0;
    let outputTokens = 0;
    for (const event of events) {
      inputTokens += event.inputTokens ?? 0;
      cachedTokens += event.cachedInputTokens ?? 0;
      outputTokens += event.outputTokens ?? 0;
    }
    const tokenTotal = inputTokens + outputTokens;
    return {
      period,
      inputTokens,
      cachedTokens,
      cacheWriteTokens: 0,
      hitRate: tokenTotal > 0 ? (cachedTokens / tokenTotal) * 100 : 0,
    };
  }

  async usageRequests(
    tenantId: string,
    period: string,
    limit: number,
    httpStatus?: number,
  ): Promise<UsageRequestsResponse> {
    const events = await this.periodEvents(tenantId, period);
    const rows = (httpStatus === undefined
      ? events
      : events.filter((event) => effectiveHttpStatus(event) === httpStatus)
    ).slice(0, limit);
    const hideClientIp = await shouldMaskClientIp(this.preferences, tenantId);
    const keyIds = [...new Set(rows.map((row) => row.apiKeyId).filter((id): id is string => id !== null))];
    const labels = await this.apiKeyLabels(tenantId, keyIds);
    return {
      items: rows.map((row) => {
        const item = mapUsageRequestItem(row, hideClientIp);
        const label = row.apiKeyId ? labels.get(row.apiKeyId) : undefined;
        return label === undefined ? item : { ...item, apiKeyLabel: label };
      }),
    };
  }
  async usageRequestDetail(
    tenantId: string,
    requestId: string,
  ): Promise<UsageRequestDetail | undefined> {
    const rows = await queryTelemetryEvents({ tenantId, requestId });
    const event = rows[0];
    if (!event) return undefined;
    const hideClientIp = await shouldMaskClientIp(this.preferences, tenantId);
    const item = mapUsageRequestItem(event, hideClientIp);
    const keyLabel = event.apiKeyId
      ? (await this.apiKeyLabels(tenantId, [event.apiKeyId])).get(event.apiKeyId)
      : undefined;
    const labeled = keyLabel === undefined ? item : { ...item, apiKeyLabel: keyLabel };
    const proxy = event.networkPoolId
      ? await resolveProxyLabel(this.db, tenantId, event.networkPoolId)
      : "direct";
    const presented = { ...labeled, proxy };
    // Filter the payload table directly instead of joining `telemetry_events`
    // only to re-apply the tenant predicate: `telemetry_payloads` carries
    // `tenant_id` itself, so the join added a second table's rows to filter for
    // no additional constraint. This matches `getEvent` above and uses
    // `telemetry_payloads_tenant_request_idx`.
    const linkedPayloadRows = await this.db
      .select({ payload: telemetryPayloads })
      .from(telemetryPayloads)
      .where(
        and(
          eq(telemetryPayloads.requestId, requestId),
          eq(telemetryPayloads.tenantId, tenantId),
        ),
      )
      .orderBy(desc(telemetryPayloads.capturedAt))
      .limit(1);
    const payloadRow = linkedPayloadRows[0]?.payload;
    const captured = await readCapturedBodies(payloadRow);
    if (!captured) {
      return { ...presented, payloads: null };
    }
    return {
      ...presented,
      payloads: {
        ...(captured.request !== undefined ? { request: captured.request } : {}),
        ...(captured.response !== undefined ? { response: captured.response } : {}),
        ...(captured.clientResponse !== undefined ? { clientResponse: captured.clientResponse } : {}),
        ...(captured.providerRequest !== undefined
          ? { providerRequest: captured.providerRequest }
          : {}),
        ...(captured.providerResponse !== undefined
          ? { providerResponse: captured.providerResponse }
          : {}),
      },
      ...(captured.signals === undefined ? {} : { payloadSignals: captured.signals }),
    };
  }

  async listEvents(
    tenantId: string,
    limit: number,
    cursor?: string,
  ): Promise<TelemetryEventListPage> {
    const before = decodeDatedCursor(cursor);
    const events = await queryTelemetryEvents({ tenantId });
    const rows = (before
      ? events.filter((event) => event.createdAt < before.createdAt || (event.createdAt === before.createdAt && event.id < before.id))
      : events
    ).slice(0, limit + 1);
    const overflow = rows.length > limit;
    const trimmed = overflow ? rows.slice(0, limit) : rows;
    const entries = trimmed.map(mapTelemetryEventRow);
    const lastEntry = entries[entries.length - 1];
    const nextCursor =
      overflow && lastEntry !== undefined
        ? encodeCursor({ createdAt: lastEntry.createdAt, id: lastEntry.id })
        : undefined;
    return nextCursor ? { entries, nextCursor } : { entries };
  }

  async getEvent(
    tenantId: string,
    eventId: string,
    includePayload = false,
    createdAt?: string,
  ): Promise<TelemetryEventDetail | undefined> {
    const events = await queryTelemetryEvents({ tenantId });
    const event = events.find(
      (candidate) =>
        candidate.id === eventId && (createdAt === undefined || candidate.createdAt === createdAt),
    );
    if (!event) return undefined;
    const base = mapTelemetryEventRow(event);
    if (!includePayload) return base;
    const payloadRows = await this.db
      .select()
      .from(telemetryPayloads)
      .where(
        and(
          eq(telemetryPayloads.requestId, event.requestId),
          eq(telemetryPayloads.tenantId, tenantId),
        ),
      )
      .orderBy(desc(telemetryPayloads.capturedAt))
      .limit(1);
    const payloadRow = payloadRows[0];
    if (!payloadRow) return base;
    const captured = await readCapturedBodies(payloadRow);
    if (!captured) return base;
    return {
      ...base,
      payload: {
        ...(captured.request !== undefined ? { requestBody: captured.request } : {}),
        ...(captured.response !== undefined ? { responseBody: captured.response } : {}),
      },
    };
  }
}

/**
 * Reads the captured bodies behind one `telemetry_payloads` row.
 *
 * The row stores typed frame-reference columns only; every body lives in the
 * frame file those columns name. Returns `undefined` when there is no row, no
 * usable reference, or the frame cannot be read — all three mean "nothing to
 * show", and the caller renders the request without a payload section. The raw
 * reference is never returned to a caller, so it cannot reach the dashboard.
 */
async function readCapturedBodies(
  row:
    | {
        readonly storage: string;
        readonly file: string;
        readonly offset: number;
        readonly length: number;
        readonly checksum: string;
        readonly version: number;
      }
    | null
    | undefined,
): Promise<
  | {
      request: unknown;
      response: unknown;
      clientResponse: unknown;
      providerRequest: unknown;
      providerResponse: unknown;
      signals?: { toolCalls: number; images: number; attachments: number };
    }
  | undefined
> {
  if (!row) return undefined;
  const reference = payloadReferenceFromRow(row);
  if (!reference) return undefined;
  try {
    const stored = await readPayloadFrame(reference);
    if (!stored || typeof stored !== "object") return undefined;
    const record = stored as Record<string, unknown>;
    const bodies = {
      request: record["request_body"] ?? undefined,
      response: record["response_body"] ?? undefined,
      clientResponse: record["client_response_body"] ?? undefined,
      providerRequest: record["provider_request_body"] ?? undefined,
      providerResponse: record["provider_response_body"] ?? undefined,
    };
    const signals =
      typeof record["signals"] === "object" &&
      record["signals"] !== null &&
      !Array.isArray(record["signals"])
        ? (record["signals"] as { toolCalls: number; images: number; attachments: number })
        : undefined;
    return {
      ...bodies,
      ...(signals === undefined ? {} : { signals }),
    };
  } catch {
    return undefined;
  }
}
