import type { LogCategory, LogLevel } from "../../application/logging";
import type { RequestRoutingMetadata, UsageDimension, UsagePeriod } from "../../application/contracts";
import type { ChartBucket, ModelTokenTotalsRow, UsageByRow, UsageCacheSummary } from "../../storage";


// ---------------------------------------------------------------------------
// Runtime metadata (read-only)
// ---------------------------------------------------------------------------

export interface RequestHistoryFilters {
  readonly period?: UsagePeriod;
  readonly providerId?: string;
  readonly model?: string;
  readonly apiKeyId?: string;
  readonly status?: "ok" | "error";
  readonly limit?: number;
  readonly cursor?: string;
  readonly clientIp?: string;
}

export interface RequestHistoryRow {
  readonly requestId: string;
  readonly endpoint: string;
  readonly surface: string;
  readonly apiKeyId: string | null;
  readonly apiKeyPrefix: string | null;
  readonly clientIp?: string | null;
  readonly providerId: string | null;
  readonly model: string | null;
  readonly statusCode: number;
  readonly errorKind: string | null;
  readonly mode: "non_stream" | "stream";
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly totalTokens: number | null;
  readonly usageSource: string;
  readonly clientName: string;
  readonly clientSource: string;
  readonly routing: RequestRoutingMetadata;
  readonly messageCount: number;
  readonly toolCount: number;
  readonly imageCount: number;
  readonly tfftMs: number | null;
  readonly payloads?: {
    readonly clientRequest: { readonly text: string; readonly truncated: boolean; readonly originalBytes: number; readonly capturedBytes: number } | null;
    readonly providerRequest: { readonly text: string; readonly truncated: boolean; readonly originalBytes: number; readonly capturedBytes: number } | null;
    readonly providerResponse: { readonly text: string; readonly truncated: boolean; readonly originalBytes: number; readonly capturedBytes: number } | null;
    readonly clientResponse: { readonly text: string; readonly truncated: boolean; readonly originalBytes: number; readonly capturedBytes: number } | null;
  } | null;
}

export interface UsageSummaryView {
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly totalTokens: number;
  readonly errors: number;
  readonly avgDurationMs: number;
  readonly estimatedCostUsd: number;
  readonly partial: boolean;
}

export interface ProviderTodayView {
  readonly providerId: string;
  readonly requests: number;
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly outputTokens: number;
  readonly errors: number;
}

export interface IpSummaryView {
  readonly ip: string;
  readonly requests: number;
  readonly errors: number;
  readonly lastRequestAt: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ConsoleLogLine {
  readonly id: number;
  readonly ts: string;
  readonly level: LogLevel;
  readonly scope: string;
  readonly category: LogCategory;
  readonly msg: string;
}

/** Compact model-probe metadata — never prompt, thinking, body, tool, or image content. */
export interface ModelProbeMetadata {
  readonly providerId: string;
  readonly model: string;
  readonly credentialMode: "auto" | "account" | "manual";
  readonly ok: boolean;
  readonly mode: "stream" | "non_stream" | null;
  readonly latencyMs: number;
  readonly errorKind: string | null;
  readonly occurredAt: string;
}

export interface RuntimeMetadataRepository {
  queryRequests(filters: RequestHistoryFilters): Promise<{ readonly items: readonly RequestHistoryRow[]; readonly nextCursor: string | null }>;
  getRequest(requestId: string): Promise<RequestHistoryRow | null>;
  queryUsageSummary(period: UsagePeriod): Promise<UsageSummaryView>;
  queryUsageCache(period: UsagePeriod): Promise<UsageCacheSummary>;
  queryUsageChart(period: UsagePeriod): Promise<readonly ChartBucket[]>;
  queryUsageBy(dimension: UsageDimension, period: UsagePeriod): Promise<readonly UsageByRow[]>;
  queryModelTokenTotals(period: UsagePeriod): Promise<readonly ModelTokenTotalsRow[]>;
  queryProviderToday(): Promise<readonly ProviderTodayView[]>;
  queryLastProviderError(providerId: string): Promise<string | null>;
  queryIpSummary(limit: number): Promise<readonly IpSummaryView[]>;
  sumKeyTokens(keyId: string): Promise<{ readonly dailyUsed: number; readonly allTimeUsed: number }>;
  queryLogs(limit: number): Promise<readonly ConsoleLogLine[]>;
  clearLogs(): Promise<void>;
  recordModelProbe(meta: ModelProbeMetadata): Promise<void>;
}

// ---------------------------------------------------------------------------
