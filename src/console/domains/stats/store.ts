import { loadavg, cpus } from "node:os";
import { and, desc, eq, gte, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../../persistence/postgres";
import type { RedisClient } from "../../../persistence/redis";
import { apiKeys, networkPools, telemetryEvents, telemetryPayloads } from "../../../persistence/schema";
import { decodeDatedCursor, encodeCursor } from "../../../persistence/page-cursor";
import { CARTETHYIA_VERSION } from "../../../transport/version";
import { CachedPreferencesReader, DrizzlePreferencesReader, type PreferencesReader } from "../../../persistence/tenant-preferences";
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
import { maskClientIp } from "../../../observability/redaction";
import { splitEndpointConfig } from "../../../network/pool/agent";
import { extractPayloadFileReference, readPayloadFrame } from "../../../observability/payload-store";
import { ConsoleDomainError } from "../../shared/errors";
import { shouldMaskClientIp } from "../../shared/ip-privacy";
import { gatewayErrorSql } from "../../../observability/telemetry-status";

function mapTelemetryEventRow(event: typeof telemetryEvents.$inferSelect): TelemetryEventView {
  return {
    id: event.id,
    createdAt: event.createdAt.toISOString(),
    tenantId: event.tenantId,
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
function effectiveHttpStatusExpression() {
  return sql<number>`coalesce(
    ${telemetryEvents.httpStatus},
    case ${telemetryEvents.status}
      when 'completed' then 200
      when 'cancelled' then 499
      when 'truncated' then 502
      else 500
    end
  )`;
}

/**
 * Counts gateway errors, not client outcomes.
 *
 * Delegates to the one shared predicate so the summary, health, breakdown and
 * the durable rollup cannot drift apart: 404/499/503 are recorded and shown
 * but never counted, because they are the caller's own outcome, a client
 * abort, or the gateway correctly refusing work it cannot do.
 */
function gatewayErrors() {
  return gatewayErrorSql(telemetryEvents.status, telemetryEvents.httpStatus);
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


function mapUsageRequestItem(
  event: typeof telemetryEvents.$inferSelect,
  hideClientIp: boolean,
): UsageRequestItem {
  const input = event.inputTokens ?? 0;
  const output = event.outputTokens ?? 0;
  return {
    requestId: event.requestId,
    ...(event.sourceSurface ? { surface: event.sourceSurface } : {}),
    ...(event.providerId ? { providerId: event.providerId } : {}),
    ...(event.accountId ? { accountId: event.accountId } : {}),
    ...(event.requestedModel ? { model: event.requestedModel } : {}),
    status: event.status ?? "unknown",
    ...(event.errorCategory ? { errorKind: event.errorCategory } : {}),
    ...(event.errorOrigin ? { errorOrigin: event.errorOrigin } : {}),
    httpStatus:
      event.httpStatus ??
      (event.status === "completed"
        ? 200
        : event.status === "cancelled"
          ? 499
          : event.status === "truncated"
            ? 502
            : 500),
    mode: event.stream ? "stream" : "non_stream",
    startedAt: event.createdAt.toISOString(),
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

/** Real Drizzle-backed observability repository used by the production console. */
export class DrizzleObservabilityStore implements ObservabilityStore {
  constructor(
    private readonly db: CartethyiaDatabase,
    private readonly redis: RedisClient,
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
      // Bounded 24h rolling window (matches the Overview copy) over the
      // tenant+created index — never a whole-table percentile sort.
      const since = new Date(Date.now() - HEALTH_WINDOW_MS);
      const rows = await this.db
        .select({
          total: sql<number>`count(*)`,
          errors: sql<number>`count(*) filter (where ${gatewayErrors()})`,
          avg: sql<number>`coalesce(avg(${telemetryEvents.latencyMs}), 0)`,
          p95: sql<number>`coalesce(percentile_cont(0.95) within group (order by ${telemetryEvents.latencyMs}), 0)`,
          p99: sql<number>`coalesce(percentile_cont(0.99) within group (order by ${telemetryEvents.latencyMs}), 0)`,
          cachedTokens: sql<number>`coalesce(sum(${telemetryEvents.cachedInputTokens}) filter (where ${telemetryEvents.cachedInputTokens} is not null), 0)`,
          inputTokens: sql<number>`coalesce(sum(${telemetryEvents.inputTokens}) filter (where ${telemetryEvents.cachedInputTokens} is not null), 0)`,
          outputTokens: sql<number>`coalesce(sum(${telemetryEvents.outputTokens}) filter (where ${telemetryEvents.cachedInputTokens} is not null), 0)`,
          avgTokensPerSec: sql<number>`coalesce(avg(${telemetryEvents.tokensPerSec}) filter (where ${telemetryEvents.tokensPerSec} is not null), 0)`,
        })
        .from(telemetryEvents)
        .where(and(eq(telemetryEvents.tenantId, tenantId), gte(telemetryEvents.createdAt, since)));
      const row = rows[0];
      total = Number(row?.total ?? 0);
      errors = Number(row?.errors ?? 0);
      avg = Math.round(Number(row?.avg ?? 0));
      p95 = Math.round(Number(row?.p95 ?? 0));
      p99 = Math.round(Number(row?.p99 ?? 0));
      const inputTokens = Number(row?.inputTokens ?? 0);
      const outputTokens = Number(row?.outputTokens ?? 0);
      // Prompt share of all tokens: the operator-facing cache column now
      // leads with input, so a cached/input ratio would read a constant 100%.
      const tokenTotal = inputTokens + outputTokens;
      cacheHitRate = tokenTotal > 0 ? Math.round((inputTokens / tokenTotal) * 10000) / 100 : 0;
      avgTokensPerSec = Number(row?.avgTokensPerSec ?? 0);
    } catch {
      databaseHealthy = false;
    }

    let redisHealthy = false;
    try {
      redisHealthy = (await this.redis.ping()) === "PONG";
    } catch {
      redisHealthy = false;
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
      memory_percent: Math.round((memory.rss / Math.max(memory.heapTotal, 1)) * 10000) / 100,
      heap_used_bytes: memory.heapUsed,
      heap_total_bytes: memory.heapTotal,
      external_bytes: memory.external,
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
    const since = periodStartDate(period);
    const scope = since
      ? and(eq(telemetryEvents.tenantId, tenantId), gte(telemetryEvents.createdAt, since))
      : eq(telemetryEvents.tenantId, tenantId);
    // Single indexed aggregate row instead of materializing every event
    // into the Node heap and regrouping in JS.
    const [totals] = await this.db
      .select({
        requestsTotal: sql<number>`count(*)`,
        requestsSucceeded: sql<number>`count(*) filter (where ${telemetryEvents.status} = 'completed')`,
        requestsFailed: sql<number>`count(*) filter (where ${gatewayErrors()})`,
        tokensUsed: sql<number>`coalesce(sum(${telemetryEvents.inputTokens} + ${telemetryEvents.outputTokens}), 0)`,
        estimatedCost: sql<number>`coalesce(sum(${telemetryEvents.estimatedCostUsd}), 0)`,
      })
      .from(telemetryEvents)
      .where(scope);
    const requestsTotal = Number(totals?.requestsTotal ?? 0);
    const requestsSucceeded = Number(totals?.requestsSucceeded ?? 0);
    const requestsFailed = Number(totals?.requestsFailed ?? 0);
    const modelRows = await this.db
      .select({
        modelId: telemetryEvents.requestedModel,
        count: sql<number>`count(*)`,
      })
      .from(telemetryEvents)
      .where(scope)
      .groupBy(telemetryEvents.requestedModel)
      .orderBy(sql`count(*) desc`)
      .limit(TOP_N);
    const providerRows = await this.db
      .select({
        providerId: telemetryEvents.providerId,
        count: sql<number>`count(*)`,
      })
      .from(telemetryEvents)
      .where(scope)
      .groupBy(telemetryEvents.providerId)
      .orderBy(sql`count(*) desc`)
      .limit(TOP_N);
    return {
      tenantId,
      period,
      requestsTotal,
      requestsSucceeded,
      requestsFailed,
      tokensUsed: Number(totals?.tokensUsed ?? 0),
      estimatedCost: Number(totals?.estimatedCost ?? 0),
      topModels: modelRows
        .filter((row) => row.modelId !== null)
        .map((row) => {
          if (typeof row.modelId !== "string")
            throw new ConsoleDomainError("internal_error", 500, "Usage model row missing modelId");
          return { modelId: row.modelId, count: Number(row.count) };
        }),
      topProviders: providerRows
        .filter((row) => row.providerId !== null)
        .map((row) => {
          if (typeof row.providerId !== "string")
            throw new ConsoleDomainError("internal_error", 500, "Usage provider row missing providerId");
          return { providerId: row.providerId, count: Number(row.count) };
        }),
    };
  }

  private usageScope(tenantId: string, period: string) {
    const since = periodStartDate(period);
    return since
      ? and(eq(telemetryEvents.tenantId, tenantId), gte(telemetryEvents.createdAt, since))
      : eq(telemetryEvents.tenantId, tenantId);
  }

  async usageSummary(tenantId: string, period: string): Promise<UsageSummaryResponse> {
    const [row] = await this.db
      .select({
        requests: sql<number>`count(*)`,
        inputTokens: sql<number>`coalesce(sum(${telemetryEvents.inputTokens}), 0)`,
        cachedTokens: sql<number>`coalesce(sum(${telemetryEvents.inputTokens}) filter (where ${telemetryEvents.cachedInputTokens} > 0), 0)`,
        outputTokens: sql<number>`coalesce(sum(${telemetryEvents.outputTokens}), 0)`,
        errors: sql<number>`count(*) filter (where ${gatewayErrors()})`,
        cancelled: sql<number>`count(*) filter (where ${telemetryEvents.status} = 'cancelled')`,
        truncated: sql<number>`count(*) filter (where ${telemetryEvents.status} = 'truncated')`,
        avgDurationMs: sql<number>`coalesce(avg(${telemetryEvents.latencyMs}), 0)`,
        estimatedCostUsd: sql<number>`coalesce(sum(${telemetryEvents.estimatedCostUsd}), 0)`,
        unpriced: sql<number>`count(*) filter (where ${telemetryEvents.status} = 'completed' and ${telemetryEvents.estimatedCostUsd} is null)`,
        avgTokensPerSec: sql<number>`coalesce(avg(${telemetryEvents.tokensPerSec}) filter (where ${telemetryEvents.tokensPerSec} is not null), 0)`,
      })
      .from(telemetryEvents)
      .where(this.usageScope(tenantId, period));
    const statusRows = await this.db
      .select({
        status: effectiveHttpStatusExpression(),
        count: sql<number>`count(*)`,
      })
      .from(telemetryEvents)
      .where(this.usageScope(tenantId, period))
      .groupBy(sql`1`)
      .orderBy(sql`1`);
    const statusCounts = statusRows.map((statusRow) => ({
      status: Number(statusRow.status),
      count: Number(statusRow.count),
    }));
    const inputTokens = Number(row?.inputTokens ?? 0);
    const cachedTokens = Number(row?.cachedTokens ?? 0);
    const outputTokens = Number(row?.outputTokens ?? 0);
    return {
      period,
      totals: {
        statusCounts,
        requests: Number(row?.requests ?? 0),
        inputTokens,
        cachedTokens,
        outputTokens,
        errors: Number(row?.errors ?? 0),
        cancelled: Number(row?.cancelled ?? 0),
        truncated: Number(row?.truncated ?? 0),
        avgDurationMs: Number(row?.avgDurationMs ?? 0),
        estimatedCostUsd: Number(row?.estimatedCostUsd ?? 0),
        partial: Number(row?.unpriced ?? 0) > 0,
        cacheHitRate: inputTokens > 0 ? (cachedTokens / inputTokens) * 100 : 0,
        avgTokensPerSec: Number(row?.avgTokensPerSec ?? 0),
      },
    };
  }

  async usageChart(tenantId: string, period: string): Promise<UsageChartResponse> {
    const since = periodStartDate(period);
    const bucketSeconds = chartBucketSeconds(period);
    const rows = await this.db
      .select({
        bucket: sql<Date>`to_timestamp(floor(extract(epoch from ${telemetryEvents.createdAt}) / ${bucketSeconds}) * ${bucketSeconds})`,
        requests: sql<number>`count(*)`,
        input: sql<number>`coalesce(sum(${telemetryEvents.inputTokens}), 0)`,
        cached: sql<number>`coalesce(sum(${telemetryEvents.inputTokens}) filter (where ${telemetryEvents.cachedInputTokens} > 0), 0)`,
        output: sql<number>`coalesce(sum(${telemetryEvents.outputTokens}), 0)`,
      })
      .from(telemetryEvents)
      .where(this.usageScope(tenantId, period))
      .groupBy(sql`1`)
      .orderBy(sql`1`);
    const byTime = new Map<number, UsageChartBucket>();
    for (const row of rows) {
      const start = Math.floor(new Date(row.bucket).getTime() / 1000) * 1000;
      if (!Number.isFinite(start)) continue;
      byTime.set(start, {
        t: new Date(start).toISOString(),
        requests: Number(row.requests ?? 0),
        input: Number(row.input ?? 0),
        cached: Number(row.cached ?? 0),
        output: Number(row.output ?? 0),
      });
    }
    const first = rows.length > 0 ? Math.min(...byTime.keys()) : undefined;
    const startMs = since ? since.getTime() : first;
    if (startMs === undefined) return { buckets: [] };
    const stepMs = bucketSeconds * 1000;
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
    const column =
      dimension === "model"
        ? telemetryEvents.requestedModel
        : dimension === "key"
          ? telemetryEvents.apiKeyId
          : dimension === "client"
            ? telemetryEvents.userAgent
            : dimension === "client_ip"
              ? telemetryEvents.clientIp
              : telemetryEvents.providerId;
    const rows = await this.db
      .select({
        name: column,
        requests: sql<number>`count(*)`,
        input: sql<number>`coalesce(sum(${telemetryEvents.inputTokens}), 0)`,
        output: sql<number>`coalesce(sum(${telemetryEvents.outputTokens}), 0)`,
        cached: sql<number>`coalesce(sum(${telemetryEvents.inputTokens}) filter (where ${telemetryEvents.cachedInputTokens} > 0), 0)`,
        errors: sql<number>`count(*) filter (where ${gatewayErrors()})`,
        cost: sql<string | null>`sum(${telemetryEvents.estimatedCostUsd})`,
        avgTokensPerSec: sql<number>`coalesce(avg(${telemetryEvents.tokensPerSec}) filter (where ${telemetryEvents.tokensPerSec} is not null), 0)`,
      })
      .from(telemetryEvents)
      .where(
        dimension === "key"
          ? and(this.usageScope(tenantId, period), isNotNull(telemetryEvents.apiKeyId))
          : and(this.usageScope(tenantId, period), isNotNull(column), ne(column, "")),
      )
      .groupBy(column)
      .orderBy(sql`count(*) desc`)
      .limit(100);
    const mapped = rows.map((row) => {
      const input = Number(row.input ?? 0);
      const output = Number(row.output ?? 0);
      const cached = Number(row.cached ?? 0);
      if (typeof row.name !== "string" || row.name.length === 0)
        throw new ConsoleDomainError("internal_error", 500, "Usage breakdown row missing name");
      const name = dimension === "client" ? clientNameFromUserAgent(row.name) : row.name;
      return {
        name,
        requests: Number(row.requests ?? 0),
        input,
        output,
        cached,
        total: input + output,
        errors: Number(row.errors ?? 0),
        costUsd: row.cost === null ? null : Number(row.cost),
        cacheHitRate: input + output > 0 ? (input / (input + output)) * 100 : 0,
        avgTokensPerSec: Number(row.avgTokensPerSec ?? 0),
      };
    });
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
    const [row] = await this.db
      .select({
        inputTokens: sql<number>`coalesce(sum(${telemetryEvents.inputTokens}), 0)`,
        cachedTokens: sql<number>`coalesce(sum(${telemetryEvents.inputTokens}) filter (where ${telemetryEvents.cachedInputTokens} > 0), 0)`,
        outputTokens: sql<number>`coalesce(sum(${telemetryEvents.outputTokens}), 0)`,
      })
      .from(telemetryEvents)
      .where(this.usageScope(tenantId, period));
    const inputTokens = Number(row?.inputTokens ?? 0);
    const cachedTokens = Number(row?.cachedTokens ?? 0);
    const outputTokens = Number(row?.outputTokens ?? 0);
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
    const scope = this.usageScope(tenantId, period);
    const filter = httpStatus === undefined
      ? scope
      : and(scope, eq(effectiveHttpStatusExpression(), httpStatus));
    const rows = await this.db
      .select()
      .from(telemetryEvents)
      .where(filter)
      .orderBy(desc(telemetryEvents.createdAt), desc(telemetryEvents.id))
      .limit(limit);
    const hideClientIp = await shouldMaskClientIp(this.preferences, tenantId);
    return { items: rows.map((row) => mapUsageRequestItem(row, hideClientIp)) };
  }
  async usageRequestDetail(
    tenantId: string,
    requestId: string,
  ): Promise<UsageRequestDetail | undefined> {
    const rows = await this.db
      .select()
      .from(telemetryEvents)
      .where(and(eq(telemetryEvents.tenantId, tenantId), eq(telemetryEvents.requestId, requestId)))
      .orderBy(desc(telemetryEvents.createdAt), desc(telemetryEvents.id))
      .limit(1);
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
    const captured = await readCapturedBodies(payloadRow?.requestBody);
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
    };
  }

  async listEvents(
    tenantId: string,
    limit: number,
    cursor?: string,
  ): Promise<TelemetryEventListPage> {
    const before = decodeDatedCursor(cursor);
    const filters = [eq(telemetryEvents.tenantId, tenantId)];
    if (before) {
      filters.push(
        sql`(${telemetryEvents.createdAt}, ${telemetryEvents.id}) < (${new Date(before.createdAt)}, ${before.id})`,
      );
    }
    const rows = await this.db
      .select()
      .from(telemetryEvents)
      .where(and(...filters))
      .orderBy(desc(telemetryEvents.createdAt), desc(telemetryEvents.id))
      .limit(limit + 1);
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
    const filters = [eq(telemetryEvents.tenantId, tenantId), eq(telemetryEvents.id, eventId)];
    if (createdAt) {
      const at = new Date(createdAt);
      if (!Number.isNaN(at.getTime())) filters.push(eq(telemetryEvents.createdAt, at));
    }
    const rows = await this.db
      .select()
      .from(telemetryEvents)
      .where(and(...filters))
      .limit(1);
    const event = rows[0];
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
    const captured = await readCapturedBodies(payloadRow.requestBody);
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
 * The row stores only `{ _payload_ref }`; every body lives in the frame file it
 * points at. Returns `undefined` when there is no row, no reference, or the
 * frame cannot be read — all three mean "nothing to show", and the caller
 * renders the request without a payload section. The raw reference is never
 * returned to a caller, so it cannot reach the dashboard.
 */
async function readCapturedBodies(referenceColumn: unknown): Promise<
  | {
      request: unknown;
      response: unknown;
      clientResponse: unknown;
      providerRequest: unknown;
      providerResponse: unknown;
    }
  | undefined
> {
  const reference = extractPayloadFileReference(referenceColumn);
  if (!reference) return undefined;
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
  return Object.values(bodies).some((body) => body !== undefined) ? bodies : undefined;
}
