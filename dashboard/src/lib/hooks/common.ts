import type { QueryFunctionContext } from "@tanstack/react-query";
import { isRecord } from "../api";
import type { ApiErrorShape } from "../api";
import type {
  ApiKeyResponse,
  AuditEntry,
  AuditListPage,

  ModelAliasRow,
  ModelCatalogEntry,
  ModelComboRow,
  NetworkPoolResponse,
  PoolStrategySetting,
  ProviderResponse,
  ProviderRoutingResponse,
  SystemHealthResponse,
  UsageByResponse,
  UsageChartResponse,
  UsageRequestDetail,
  UsageRequestsResponse,
  UsageSummaryResponse,
} from "../contracts";

export const QUERY_OPTIONS = {
  staleTime: 10_000,
  gcTime: 120_000,
  retry: false,
  refetchOnWindowFocus: false,
} as const;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function invalidResponse(message: string): ApiErrorShape {
  return { status: 500, code: "invalid_response", message };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function assertSystemHealth(value: unknown): SystemHealthResponse {
  if (!isRecord(value) || !["healthy", "degraded", "unhealthy"].includes(value.status as string)) {
    throw invalidResponse("Invalid system health response");
  }
  const numericFields = [
    "uptime_seconds",
    "memory_bytes",
    "memory_percent",
    "heap_used_bytes",
    "external_bytes",
    "cpu_percent",
    "request_count",
    "error_count",
    "latency_avg_ms",
    "latency_p95_ms",
    "latency_p99_ms",
  ];
  if (
    !numericFields.every((field) => isFiniteNumber(value[field])) ||
    typeof value.database_healthy !== "boolean" ||
    typeof value.redis_healthy !== "boolean"
  ) {
    throw invalidResponse("Invalid system health response");
  }
  return value as unknown as SystemHealthResponse;
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

export function assertUsageSummary(value: unknown): UsageSummaryResponse {
  if (!isRecord(value) || typeof value.period !== "string" || !isRecord(value.totals)) {
    throw invalidResponse("Invalid usage summary response");
  }
  const totals = value.totals;
  const numericFields = [
    "requests",
    "inputTokens",
    "cachedTokens",
    "outputTokens",
    "errors",
    "cancelled",
    "truncated",
    "avgDurationMs",
    "estimatedCostUsd",
    "cacheHitRate",
  ];
  if (!numericFields.every((field) => isFiniteNumber(totals[field])) || typeof totals.partial !== "boolean") {
    throw invalidResponse("Invalid usage summary response");
  }
  if (
    !Array.isArray(totals.statusCounts) ||
    !totals.statusCounts.every(
      (item) => isRecord(item) && isFiniteNumber(item.status) && isFiniteNumber(item.count),
    )
  ) {
    throw invalidResponse("Invalid usage status counts");
  }
  return value as unknown as UsageSummaryResponse;
}

export function assertUsageChart(value: unknown): UsageChartResponse {
  if (!isRecord(value) || !Array.isArray(value.buckets)) {
    throw invalidResponse("Invalid usage chart response");
  }
  for (const bucket of value.buckets) {
    if (
      !isRecord(bucket) ||
      typeof bucket.t !== "string" ||
      !["requests", "input", "cached", "output"].every((field) => isFiniteNumber(bucket[field]))
    ) {
      throw invalidResponse("Invalid usage chart response");
    }
  }
  return value as unknown as UsageChartResponse;
}
export function assertUsageBy(value: unknown): UsageByResponse {
  if (!isRecord(value) || !Array.isArray(value.rows)) {
    throw invalidResponse("Invalid usage breakdown response");
  }
  for (const row of value.rows) {
    if (
      !isRecord(row) ||
      typeof row.name !== "string" ||
      !["requests", "input", "output", "cached", "total", "errors"].every((field) =>
        isFiniteNumber(row[field]),
      ) ||
      !(row.costUsd === null || isFiniteNumber(row.costUsd)) ||
      (row.label !== undefined && typeof row.label !== "string")
    ) {
      throw invalidResponse("Invalid usage breakdown response");
    }
  }
  return value as unknown as UsageByResponse;
}

function assertUsageRequestItem(value: unknown): void {
  if (!isRecord(value) || typeof value.requestId !== "string" || typeof value.startedAt !== "string") {
    throw invalidResponse("Invalid usage request response");
  }
  if (typeof value.status !== "string" || (value.mode !== "stream" && value.mode !== "non_stream")) {
    throw invalidResponse("Invalid usage request response");
  }
  if (value.accountId !== undefined && typeof value.accountId !== "string") {
    throw invalidResponse("Invalid usage request response");
  }
  for (const field of ["endpoint", "apiKeyId", "userAgent", "clientName", "clientIp"]) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw invalidResponse("Invalid usage request response");
    }
  }
  for (const field of [
    "durationMs",
    "inputTokens",
    "outputTokens",
    "cachedTokens",
    "reasoningTokens",
    "totalTokens",
    "ttfbMs",
    "tokensPerSec",
    "estimatedCost",
  ]) {
    if (!isOptionalFiniteNumber(value[field])) throw invalidResponse("Invalid usage request response");
  }
}

export function assertUsageRequests(value: unknown): UsageRequestsResponse {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw invalidResponse("Invalid usage requests response");
  }
  for (const item of value.items) assertUsageRequestItem(item);
  return value as unknown as UsageRequestsResponse;
}

export function assertUsageRequestDetail(value: unknown): UsageRequestDetail {
  if (!isRecord(value)) throw invalidResponse("Invalid usage request response");
  assertUsageRequestItem(value);
  if (value.payloads !== undefined && value.payloads !== null && !isRecord(value.payloads)) {
    throw invalidResponse("Invalid usage request response");
  }
  return value as unknown as UsageRequestDetail;
}

export function assertAuditListPage(value: unknown): AuditListPage {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    throw invalidResponse("Invalid audit response");
  }
  const entries = value.entries.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.createdAt !== "string" ||
      typeof entry.actor !== "string" ||
      typeof entry.action !== "string" ||
      typeof entry.target !== "string"
    ) {
      throw invalidResponse("Invalid audit response");
    }
    return entry as unknown as AuditEntry;
  });
  return typeof value.nextCursor === "string"
    ? { entries, nextCursor: value.nextCursor }
    : { entries };
}

export function assertProviders(value: unknown): ProviderResponse[] {
  if (!Array.isArray(value)) throw invalidResponse("Invalid provider response");
  return value.map((provider) => {
    if (
      !isRecord(provider) ||
      typeof provider.providerId !== "string" ||
      typeof provider.enabled !== "boolean" ||
      typeof provider.isBuiltIn !== "boolean"
    ) {
      throw invalidResponse("Invalid provider response");
    }
    return provider as unknown as ProviderResponse;
  });
}

export function assertModels(value: unknown): ModelCatalogEntry[] {
  if (!Array.isArray(value)) throw invalidResponse("Invalid model response");
  return value.map((model) => {
    if (
      !isRecord(model) ||
      typeof model.modelId !== "string" ||
      typeof model.route !== "string" ||
      typeof model.provider !== "string"
    ) {
      throw invalidResponse("Invalid model response");
    }
    return model as unknown as ModelCatalogEntry;
  });
}

export function assertModelAliases(value: unknown): ModelAliasRow[] {
  if (!Array.isArray(value)) throw invalidResponse("Invalid model alias response");
  return value.map((row) => {
    if (
      !isRecord(row) ||
      typeof row.id !== "string" ||
      typeof row.tenantId !== "string" ||
      typeof row.alias !== "string" ||
      typeof row.targetModel !== "string" ||
      typeof row.createdAt !== "string" ||
      typeof row.updatedAt !== "string"
    ) {
      throw invalidResponse("Invalid model alias response");
    }
    return row as unknown as ModelAliasRow;
  });
}

export function assertModelCombos(value: unknown): ModelComboRow[] {
  if (!Array.isArray(value)) throw invalidResponse("Invalid model combo response");
  return value.map((row) => {
    if (
      !isRecord(row) ||
      typeof row.id !== "string" ||
      typeof row.tenantId !== "string" ||
      typeof row.name !== "string" ||
      !isStringArray(row.members) ||
      typeof row.strategy !== "string" ||
      typeof row.createdAt !== "string" ||
      typeof row.updatedAt !== "string"
    ) {
      throw invalidResponse("Invalid model combo response");
    }
    return row as unknown as ModelComboRow;
  });
}

export function assertProviderRouting(value: unknown): ProviderRoutingResponse {
  if (
    !isRecord(value) ||
    typeof value.providerId !== "string" ||
    typeof value.strategy !== "string" ||
    typeof value.rotateCount !== "number" ||
    value.rotateCount < 1 ||
    value.rotateCount > 1000 ||
    typeof value.enabled !== "boolean" ||
    (value.maxInflight !== null && typeof value.maxInflight !== "number") ||
    typeof value.bypassProxy !== "boolean"
  ) {
    throw invalidResponse("Invalid provider routing response");
  }
  return value as unknown as ProviderRoutingResponse;
}

export function assertPoolStrategy(value: unknown): PoolStrategySetting {
  if (
    !isRecord(value) ||
    typeof value.strategy !== "string" ||
    typeof value.rotateCount !== "number" ||
    value.rotateCount < 1 ||
    value.rotateCount > 1000
  ) {
    throw invalidResponse("Invalid pool strategy response");
  }
  return value as unknown as PoolStrategySetting;
}

export function assertApiKeys(value: unknown): ApiKeyResponse[] {
  if (!Array.isArray(value)) throw invalidResponse("Invalid API key response");
  return value.map((key) => {
    if (
      !isRecord(key) ||
      typeof key.id !== "string" ||
      !isStringArray(key.scopes) ||
      typeof key.createdAt !== "string"
    ) {
      throw invalidResponse("Invalid API key response");
    }
    return key as unknown as ApiKeyResponse;
  });
}

export function assertNetworkPools(value: unknown): NetworkPoolResponse[] {
  if (!Array.isArray(value)) throw invalidResponse("Invalid network pools response");
  return value.map((pool) => {
    if (
      !isRecord(pool) ||
      typeof pool.id !== "string" ||
      typeof pool.kind !== "string" ||
      typeof pool.endpoint !== "string" ||
      !["active", "degraded", "cooldown", "disabled"].includes(pool.status as string)
    ) {
      throw invalidResponse("Invalid network pool response");
    }
    return pool as unknown as NetworkPoolResponse;
  });
}

export function querySignal(context: QueryFunctionContext): AbortSignal {
  return context.signal;
}
