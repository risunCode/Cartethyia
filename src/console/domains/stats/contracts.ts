import type { ConsoleAccessResolver } from "../../auth/access";
// Telemetry domain: system health, usage, and telemetry-event read API.

import { ConsoleDomainError, consoleErrorHandler, requireTenantScope } from "../../shared/errors";
import { parseQueryLimit } from "../../shared/query";
import { Elysia, t } from "elysia";
import type { AccessDecision } from "../../../security/access-control";
import { redactTelemetryValue } from "../../../observability/redaction";

/**
 * Whitelisted usage periods. Numeric tokens bound the aggregation window;
 * `"all"` is the single explicit unbounded token. Anything else is rejected
 * before any database query so a typo cannot trigger a full-table scan.
 */
export function isSupportedUsagePeriod(period: string): boolean {
  if (period === "all") return true;
  const match = /^(\d+)([hd])$/.exec(period);
  if (!match) return false;
  const amount = Number(match[1]);
  const cap = match[2] === "h" ? 8760 : 365;
  return Number.isSafeInteger(amount) && amount >= 1 && amount <= cap;
}

export { USAGE_PERIODS, type UsagePeriod } from "./usage-periods";

export interface SystemHealthResponse {
  version: string;
  status: "healthy" | "degraded" | "unhealthy";
  uptime_seconds: number;
  database_healthy: boolean;
  redis_healthy: boolean;
  memory_bytes: number;
  memory_percent: number;
  heap_used_bytes: number;
  heap_total_bytes: number;
  external_bytes: number;
  cpu_percent: number;
  cpu_cores: number;
  pid: number;
  platform: string;
  request_count: number;
  error_count: number;
  latency_avg_ms: number;
  latency_p95_ms: number;
  latency_p99_ms: number;
  cache_hit_rate_percent: number;
  avg_tokens_per_sec: number;
}
export interface UsageResponse {
  tenantId: string;
  period: string;
  requestsTotal: number;
  requestsSucceeded: number;
  requestsFailed: number;
  tokensUsed: number;
  estimatedCost: number;
  topModels: Array<{ modelId: string; count: number }>;
  topProviders: Array<{ providerId: string; count: number }>;
}

/** Period-bound usage summary mirroring the 20-beta analytics surface. */
export interface UsageSummaryTotals {
  requests: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  /**
   * Failed and truncated requests. Client aborts (`cancelled`, rendered 499)
   * are expected client behavior, never an error, and are tracked separately.
   */
  errors: number;
  /** Client-cancelled requests (rendered `499`) — a sub-count, never an error. */
  cancelled: number;
  /** Streams that ended early (`502`); also included in `errors`. */
  truncated: number;
  /** Counts by actual HTTP status for the clickable Requests filters. */
  statusCounts: Array<{ status: number; count: number }>;
  avgDurationMs: number;
  estimatedCostUsd: number;
  /** True when completed rows without persisted cost exist in the window. */
  partial: boolean;
  /** Cache hit rate percentage (0-100). */
  cacheHitRate: number;
  /** Average tokens per second across the period. */
  avgTokensPerSec: number;
}
export interface UsageSummaryResponse {
  period: string;
  totals: UsageSummaryTotals;
}
export interface UsageChartBucket {
  /** Bucket start as ISO timestamp. */
  t: string;
  requests: number;
  input: number;
  cached: number;
  output: number;
}
export interface UsageChartResponse {
  buckets: UsageChartBucket[];
}
export interface UsageByRow {
  name: string;
  requests: number;
  input: number;
  output: number;
  cached: number;
  total: number;
  errors: number;
  /** Null when no row in the group carries persisted cost. */
  costUsd: number | null;
  /** Resolved API key label for the `key` dimension; absent otherwise. */
  label?: string;
  /** Cache hit rate percentage (0-100). */
  cacheHitRate: number;
  /** Average tokens per second for this dimension. */
  avgTokensPerSec: number;
}
/**
 * Breakdown dimensions the usage endpoint accepts. One runtime tuple, because
 * three layers read it: the route table registers one `by-<dimension>` path per
 * member, the operations validator rejects anything outside it, and the
 * dashboard's `Dimension` union mirrors it (pinned by
 * `dashboard/test/usage-dimensions-parity.test.ts`).
 */
export const USAGE_DIMENSIONS = ["model", "provider", "key", "client", "client_ip"] as const;

/** One usage breakdown dimension. */
export type UsageDimension = (typeof USAGE_DIMENSIONS)[number];

export interface UsageByResponse {
  rows: UsageByRow[];
}
export interface UsageCacheResponse {
  period: string;
  inputTokens: number;
  cachedTokens: number;
  /** Always zero: cache-write tokens are not tracked by the telemetry schema. */
  cacheWriteTokens: number;
  hitRate: number;
}
export type UsageRequestMode = "stream" | "non_stream";
export interface UsageRequestItem {
  requestId: string;
  surface?: string;
  providerId?: string;
  /** Provider account (credential) that served this request, if any. */
  accountId?: string;
  model?: string;
  endpoint?: string;
  apiKeyId?: string;
  userAgent?: string;
  clientName?: string;
  estimatedCost?: number;
  /** Resolved API key label; absent when the key is gone or unknown. */
  apiKeyLabel?: string;
  /** HTTP status the client actually received; absent on historical rows. */
  httpStatus?: number;
  status: string;
  errorKind?: string;
  /**
   * Which layer failed: `cartethyia` (the gateway), `upstream` (the provider),
   * or `network`. Absent for rows written before the column existed.
   */
  errorOrigin?: string;
  mode: UsageRequestMode;
  startedAt: string;
  clientIp?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  ttfbMs?: number;
  tokensPerSec?: number;
  firstContentDeltaAtMs?: number;
  lastEventAtMs?: number;
}
export interface UsageRequestsResponse {
  items: UsageRequestItem[];
}
export interface UsageRequestDetail extends UsageRequestItem {
  proxy?: string;
  payloads?: {
    request?: unknown;
    response?: unknown;
    /** Body Cartethyia returned to the client (post-translation). */
    clientResponse?: unknown;
    providerRequest?: unknown;
    providerResponse?: unknown;
  } | null;
}
export interface TelemetryEventView {
  id: string;
  createdAt: string;
  tenantId: string;
  requestId: string;
  sourceSurface?: string;
  requestedModel?: string;
  providerId?: string;
  latencyMs?: number;
  status?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCost?: number;
  tokensPerSec?: number;
  firstContentDeltaAtMs?: number;
  lastEventAtMs?: number;
}
export interface TelemetryEventDetail extends TelemetryEventView {
  payload?: { requestBody?: unknown; responseBody?: unknown };
}
export interface TelemetryEventListPage {
  entries: readonly TelemetryEventView[];
  /** Opaque cursor for the next page; `undefined` when the tail is reached. */
  nextCursor?: string;
}
export interface ObservabilityStore {
  health(tenantId: string): Promise<SystemHealthResponse>;
  usage(tenantId: string, period: string): Promise<UsageResponse>;
  listEvents(tenantId: string, limit: number, cursor?: string): Promise<TelemetryEventListPage>;
  getEvent(
    tenantId: string,
    eventId: string,
    includePayload: boolean,
    createdAt?: string,
  ): Promise<TelemetryEventDetail | undefined>;
  usageSummary(tenantId: string, period: string): Promise<UsageSummaryResponse>;
  usageChart(tenantId: string, period: string): Promise<UsageChartResponse>;
  usageBy(
    tenantId: string,
    dimension: UsageDimension,
    period: string,
  ): Promise<UsageByResponse>;
  usageCache(tenantId: string, period: string): Promise<UsageCacheResponse>;
  usageRequests(
    tenantId: string,
    period: string,
    limit: number,
    httpStatus?: number,
  ): Promise<UsageRequestsResponse>;
  usageRequestDetail(tenantId: string, requestId: string): Promise<UsageRequestDetail | undefined>;
}
export interface ObservabilityConfig {
  readonly store: ObservabilityStore;
  readonly accessResolver: ConsoleAccessResolver;
}

export function createObservabilityOperations(config: ObservabilityConfig) {
  const operations = {
    async getSystemHealth(access: AccessDecision | undefined): Promise<SystemHealthResponse> {
        const a = requireTenantScope(access, "dashboard:read");
        const h = await config.store.health(a.tenantId);
        return redactTelemetryValue(h) as SystemHealthResponse;
      },
    async getTenantUsage(access: AccessDecision | undefined, period = "7d"): Promise<UsageResponse> {
        const a = requireTenantScope(access, "dashboard:read");
        if (!isSupportedUsagePeriod(period)) {
          throw new ConsoleDomainError(
            "invalid_period",
            400,
            `Unsupported usage period: ${period}. Use "24h", "7d", "30d", or "all".`,
          );
        }
        return config.store.usage(a.tenantId, period);
      },
    async listEvents(
        access: AccessDecision | undefined,
        limit?: string,
        cursor?: string,
      ): Promise<TelemetryEventListPage> {
        const a = requireTenantScope(access, "dashboard:read");
        const lim = parseQueryLimit(limit, 50, 100);
        const page = await config.store.listEvents(a.tenantId, lim, cursor);
        const entries = redactTelemetryValue(page.entries) as TelemetryEventView[];
        return page.nextCursor ? { entries, nextCursor: page.nextCursor } : { entries };
      },
    async getEventDetail(
        access: AccessDecision | undefined,
        eventId: string,
        includePayload = false,
        createdAt?: string,
      ): Promise<TelemetryEventDetail> {
        const a = requireTenantScope(access, "dashboard:read");
        const detail = await config.store.getEvent(
          a.tenantId,
          eventId,
          includePayload,
          createdAt,
        );
        if (!detail) throw new ConsoleDomainError("event_not_found", 404, `Event ${eventId} not found`);
        return redactTelemetryValue(detail) as TelemetryEventDetail;
      },
    requirePeriod(period: string): string {
        if (!isSupportedUsagePeriod(period)) {
          throw new ConsoleDomainError(
            "invalid_period",
            400,
            `Unsupported usage period: ${period}. Use "1h", "24h", "7d", "30d", or "all".`,
          );
        }
        return period;
      },
    requireTenant(access: AccessDecision | undefined): string {
        const a = requireTenantScope(access, "dashboard:read");
        return a.tenantId;
      },
    async getUsageSummary(
        access: AccessDecision | undefined,
        period = "24h",
      ): Promise<UsageSummaryResponse> {
        const tenantId = operations.requireTenant(access);
        return config.store.usageSummary(tenantId, operations.requirePeriod(period));
      },
    async getUsageChart(
        access: AccessDecision | undefined,
        period = "24h",
      ): Promise<UsageChartResponse> {
        const tenantId = operations.requireTenant(access);
        return config.store.usageChart(tenantId, operations.requirePeriod(period));
      },
    async getUsageBy(
        access: AccessDecision | undefined,
        dimension: UsageDimension,
        period = "24h",
      ): Promise<UsageByResponse> {
        const tenantId = operations.requireTenant(access);
        if (!(USAGE_DIMENSIONS as readonly string[]).includes(dimension)) {
          throw new ConsoleDomainError(
            "invalid_dimension",
            400,
            `Unsupported usage dimension: ${dimension}. Use ${USAGE_DIMENSIONS.map((d) => `"${d}"`).join(", ")}.`,
          );
        }
        return config.store.usageBy(tenantId, dimension, operations.requirePeriod(period));
      },
    async getUsageCache(
        access: AccessDecision | undefined,
        period = "24h",
      ): Promise<UsageCacheResponse> {
        const tenantId = operations.requireTenant(access);
        return config.store.usageCache(tenantId, operations.requirePeriod(period));
      },
    async listUsageRequests(
      access: AccessDecision | undefined,
      period = "24h",
      limit?: string,
      httpStatus?: string,
    ): Promise<UsageRequestsResponse> {
      const tenantId = operations.requireTenant(access);
      let parsedStatus: number | undefined;
      if (httpStatus !== undefined) {
        parsedStatus = Number(httpStatus);
        if (!Number.isInteger(parsedStatus) || parsedStatus < 100 || parsedStatus > 599) {
          throw new ConsoleDomainError("invalid_request", 400, "Invalid HTTP status filter");
        }
      }
      return config.store.usageRequests(
        tenantId,
        operations.requirePeriod(period),
        parseQueryLimit(limit, 50, 500),
        parsedStatus,
      );
    },
    async getUsageRequestDetail(
        access: AccessDecision | undefined,
        requestId: string,
      ): Promise<UsageRequestDetail> {
        const tenantId = operations.requireTenant(access);
        const detail = await config.store.usageRequestDetail(tenantId, requestId);
        if (!detail) throw new ConsoleDomainError("event_not_found", 404, `Request ${requestId} not found`);
        const payloads = detail.payloads ?? null;
        return { ...detail, payloads };
      },
  };
  return operations;
}

const usageQuery = t.Object({ period: t.Optional(t.String()) });
const telemetryListQuery = t.Object({
  period: t.Optional(t.String()),
  limit: t.Optional(t.String()),
  cursor: t.Optional(t.String()),
});
const usageRequestsQuery = t.Object({
  period: t.Optional(t.String()),
  limit: t.Optional(t.String()),
  httpStatus: t.Optional(t.String()),
});
const telemetryDetailQuery = t.Object({
  includePayload: t.Optional(t.String()),
  createdAt: t.Optional(t.String()),
});
export function createObservabilityRoutes(config: ObservabilityConfig): Elysia {
  const factory = createObservabilityOperations(config);
  return new Elysia()
    .error(consoleErrorHandler("Observability operation failed"))
    .get("/system/health", async ({ request }) => {
      return await factory.getSystemHealth(config.accessResolver(request));
})
    .get("/system/usage", { query: usageQuery }, async ({ request, query }) => {
      return await factory.getTenantUsage(config.accessResolver(request), query.period);
})
    .get("/system/usage/summary", { query: usageQuery }, async ({ request, query }) => {
      return await factory.getUsageSummary(config.accessResolver(request), query.period);
})
    .get("/system/usage/chart", { query: usageQuery }, async ({ request, query }) => {
      return await factory.getUsageChart(config.accessResolver(request), query.period);
})
    // One `by-<dimension>` route per member of `USAGE_DIMENSIONS`, so a new
    // dimension cannot be added to the validator without its route existing.
    .get(
      "/system/usage/by-:dimension",
      { query: usageQuery, params: t.Object({ dimension: t.String() }) },
      async ({ request, params, query }) => {
        const dimension = params.dimension as UsageDimension;
        if (!(USAGE_DIMENSIONS as readonly string[]).includes(dimension)) {
          throw new ConsoleDomainError(
            "invalid_dimension",
            404,
            `Unknown usage dimension: ${dimension}`,
          );
        }
        return await factory.getUsageBy(config.accessResolver(request), dimension, query.period);
},
    )
    .get("/system/usage/cache", { query: usageQuery }, async ({ request, query }) => {
      return await factory.getUsageCache(config.accessResolver(request), query.period);
})
    .get("/system/usage/requests", { query: usageRequestsQuery }, async ({ request, query }) => {
      return await factory.listUsageRequests(
        config.accessResolver(request),
        query.period,
        query.limit,
        query.httpStatus,
      );
})
    .get("/system/usage/requests/:requestId", async ({ request, params }) => {
      return await factory.getUsageRequestDetail(config.accessResolver(request), params.requestId);
})
    .get("/telemetry/events", { query: telemetryListQuery }, async ({ request, query }) => {
      return await factory.listEvents(
        config.accessResolver(request),
        query.limit,
        query.cursor,
      );
})
    .get(
      "/telemetry/events/:eventId",
      { query: telemetryDetailQuery },
      async ({ request, params, query }) => {
        return await factory.getEventDetail(
          config.accessResolver(request),
          params.eventId,
          query.includePayload === "true",
          query.createdAt,
        );
},
    ) as unknown as Elysia;
}
