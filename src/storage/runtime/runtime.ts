import { Database } from "bun:sqlite";
import { sanitizeMessage, type ClientDetectionSource, type ClientName, type UsageDimension, type UsagePeriod } from "../../application/contracts";
import type { LogCategory, LogCategoryFilter } from "../../application/logging";
import type { LogLevel } from "../../application/logging";
import type { RequestRoutingMetadata, TelemetryWriter } from "../../application/contracts";
import type { PersistenceEnv } from "../main/env";
import type { RuntimeTelemetryStats } from "./write-buffer";
import type { WarpMetricsRepository } from "./warp-metrics";
export { retainRuntimeData } from "./retention";
export { createRuntimePersistence, getConsoleLogRepository, getRuntimeMetadataRepository, getRuntimePersistence, resetRuntimePersistenceForTests, setRetentionDefaults } from "./persistence";
export { createRuntimeMetadataRepository } from "./metadata";
export { createConsoleLogRepository } from "./console-logs";
export { createWarpMetricsRepository } from "./warp-metrics";
export type { WarpMetricRow, WarpMetricsRepository, WarpMetricsSummary } from "./warp-metrics";
export type { RuntimeTelemetryStats } from "./write-buffer";
export { createRuntimeTelemetryWriter } from "./telemetry-writer";
export type ConsoleLogCategory = LogCategory;
export type ConsoleLogCategoryFilter = LogCategoryFilter;

// ────────────────────────────── Row shapes ──────────────────────────────────

export interface RuntimeRequestRow {
  readonly id: number;
  readonly requestId: string;
  readonly endpoint: string;
  readonly surface: string;
  readonly apiKeyId: string | null;
  readonly apiKeyPrefix: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly status: number | null;
  readonly errorKind: string | null;
  readonly mode: "non_stream" | "stream";
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly totalTokens: number | null;
  readonly usageSource: string;
  readonly clientName: string;
  readonly clientSource: string;
  readonly messageCount: number;
  readonly toolCount: number;
  readonly imageCount: number;
  readonly tfftMs: number | null;
  readonly clientIp: string | null;
  readonly routing: RequestRoutingMetadata;
}

export interface RuntimeRequestFilters {
  readonly cursor?: string | number;
  readonly provider?: string;
  readonly model?: string;
  readonly key?: string;
  readonly status?: number;
  readonly stream?: boolean;
  readonly q?: string;
  readonly limit?: number;
  readonly clientIp?: string;
}

export interface RuntimeRequestPage {
  readonly items: readonly RuntimeRequestRow[];
  readonly nextCursor: number | null;
}

export interface UsageSummary {
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly errors: number;
  readonly avgDurationMs: number;
}

export interface UsageCacheRow {
  readonly name: string;
  readonly requests: number;
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly cacheWriteTokens: number;
  readonly hitRate: number;
}

export interface UsageCacheSummary {
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly cacheWriteTokens: number;
  readonly hitRate: number;
  readonly rows: readonly UsageCacheRow[];
}

export interface ChartBucket {
  readonly t: string;
  readonly requests: number;
  readonly input: number;
  readonly cached: number;
  readonly output: number;
}

export interface UsageByRow {
  readonly name: string;
  readonly requests: number;
  readonly input: number;
  readonly output: number;
  readonly cached: number;
  readonly total: number;
  readonly errors: number;
  readonly costUsd: number | null;
}

export interface ProviderModelTotalsRow {
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ModelTokenTotalsRow {
  readonly model: string;
  readonly provider: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ProviderTodayRow {
  readonly provider: string;
  readonly requests: number;
  readonly input: number;
  readonly cached: number;
  readonly output: number;
  readonly errors: number;
}

export interface IpSummaryRow {
  readonly ip: string;
  readonly requests: number;
  readonly errors: number;
  readonly lastRequestAt: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ApiKeyUsageRow {
  readonly apiKeyId: string;
  readonly totalUsage: number;
  readonly totalRequests: number;
}
export interface ConsoleLogRow {
  readonly id: number;
  readonly ts: string;
  readonly level: LogLevel;
  readonly scope: string;
  readonly category: LogCategory;
  readonly msg: string;
}

export interface ConsoleLogFilters {
  readonly category?: LogCategoryFilter;
  readonly level?: LogLevel;
  readonly scope?: string;
  readonly limit?: number;
  readonly cursor?: number;
}

export interface RetentionResult {
  readonly historyRemoved: number;
  readonly consoleLogsRemoved: number;
  readonly detailsRemoved: number;
  readonly toolCallsRemoved: number;
  readonly assetFilesRemoved: number;
  readonly payloadsRemoved: number;
}

export interface RuntimePayloadArtifact {
  readonly text: string;
  readonly truncated: boolean;
  readonly originalBytes: number;
  readonly capturedBytes: number;
}

export interface RuntimePayloadRecord {
  readonly requestId: string;
  readonly clientRequest: RuntimePayloadArtifact | null;
  readonly providerRequest: RuntimePayloadArtifact | null;
  readonly providerResponse: RuntimePayloadArtifact | null;
  readonly clientResponse: RuntimePayloadArtifact | null;
}

export interface RuntimePayloadRepository {
  save(requestId: string, kind: "client_request" | "provider_request" | "provider_response" | "client_response", artifact: RuntimePayloadArtifact): void;
  get(requestId: string): RuntimePayloadRecord | null;
}

export interface RuntimeMetadataRepository {
  queryRequests(filters: RuntimeRequestFilters): RuntimeRequestPage;
  getRequestById(id: number): RuntimeRequestRow | null;
  querySummary(period: UsagePeriod): UsageSummary;
  queryCache(period: UsagePeriod): UsageCacheSummary;
  queryChart(period: UsagePeriod): ChartBucket[];
  queryBy(dimension: UsageDimension, period: UsagePeriod): UsageByRow[];
  queryProviderModelTotals(period: UsagePeriod): ProviderModelTotalsRow[];
  queryModelTokenTotals(period: UsagePeriod): ModelTokenTotalsRow[];
  queryProviderToday(): ProviderTodayRow[];
  queryLastProviderError(provider: string): string | null;
  queryIpSummary(limit: number): IpSummaryRow[];
  sumKeyTokens(keyId: string): { readonly dailyUsed: number; readonly monthlyUsed: number; readonly allTimeUsed: number };
  queryApiKeyUsage(): ApiKeyUsageRow[];
  invalidate(): void;
}
export interface ConsoleLogRepository {
  push(level: LogLevel, scope: string, msg: string): void;
  clear(): void;
  list(filters: ConsoleLogFilters): { items: ConsoleLogRow[]; nextCursor: number | null };
  after(afterId: number, limit: number, filters?: ConsoleLogFilters): ConsoleLogRow[];
  onPush(listener: () => void): () => void;
}

export interface RuntimePersistence {
  readonly env: PersistenceEnv;
  readonly telemetry: TelemetryWriter;
  readonly metadata: RuntimeMetadataRepository;
  readonly payloads: RuntimePayloadRepository;
  readonly consoleLogs: ConsoleLogRepository;
  readonly warpMetrics: WarpMetricsRepository;
  readonly retain: (options?: { logRetentionDays?: number; assetRetentionDays?: number }) => RetentionResult;
  readonly startRetentionMaintenance: (intervalMs?: number) => { stop(): void };
  readonly flush: () => void;
  readonly pendingWrites: () => number;
  readonly telemetryStats?: () => RuntimeTelemetryStats;
  readonly checkpoint: () => void;
  readonly resetAll: () => void;
  readonly close: () => void;
  /**
   * Live `Database` handle for coordinated admin writes (db-map SQL console).
   * Exposed only because the database browser needs raw SQL access that the
   * repository boundary cannot express; never use this from request hot paths.
   */
  readonly db: () => Database;
  /**
   * Checkpoint and close the current connection so the live file can be
   * renamed/overwritten (db-map import). Unlike the terminal shutdown
   * `close()`, the singleton can be brought back with `reopen()`.
   */
  readonly closeForSwap: () => void;
  /**
   * Reopen a fresh connection at the same path so a swapped database file
   * (db-map import) is picked up by all repositories.
   */
  readonly reopen: () => void;
}

// ────────────────────────────── Schema ──────────────────────────────────────

import { RUNTIME_SCHEMA_SQL } from "./schema.sql";
export { RUNTIME_SCHEMA_SQL };

interface TableRow {
  name: string;
}

export function clearAllRuntimeTables(database: Database): void {
  const tables = (database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as TableRow[]).map((row) => row.name);
  database.exec("PRAGMA foreign_keys = OFF");
  try {
    database.transaction(() => {
      for (const table of tables) database.query(`DELETE FROM "${table.replaceAll('"', '""')}"`).run();
      if (database.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").get() !== null) database.query("DELETE FROM sqlite_sequence").run();
    })();
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}

/**
 * Idempotent runtime schema creation. Applies the direct-cutover schema
 * (CREATE IF NOT EXISTS) and promotes trace_id to UNIQUE when safe. Legacy
 * `request_details` stores are redacted to meta-only once on upgrade.
 */
export function ensureRuntimeSchema(db: Database): { traceIdUnique: boolean } {
  db.exec(RUNTIME_SCHEMA_SQL);

  // Promote trace_id to UNIQUE only when no duplicates exist (legacy DBs may
  // have accumulated dupes before the constraint was introduced).
  const { total, distinct_ids } = db
    .query("SELECT COUNT(*) AS total, COUNT(DISTINCT trace_id) AS distinct_ids FROM request_history")
    .get() as { total: number; distinct_ids: number };
  if (total === distinct_ids) {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS uq_request_history_trace_id ON request_history(trace_id)");
    db.exec("DROP INDEX IF EXISTS idx_request_history_trace_id");
  }

  // Legacy redaction migration: clear stored bodies, keep metadata only.
  if (tableExists(db, "request_details")) {
    db.exec(
      "UPDATE request_details SET redacted_request = NULL, redacted_response = NULL, payload_mode = CASE WHEN payload_mode IS NULL THEN NULL ELSE 'meta' END WHERE redacted_request IS NOT NULL OR redacted_response IS NOT NULL OR payload_mode = 'store'",
    );
  }
  return { traceIdUnique: total === distinct_ids };
}

// ────────────────────────────── Utilities ───────────────────────────────────

const KNOWN_CLIENT_NAMES: ReadonlySet<string> = new Set(["github_copilot", "claude_code", "codex", "cursor", "cline", "opencode", "pi", "unknown"]);
const KNOWN_CLIENT_SOURCES: ReadonlySet<string> = new Set(["explicit_header", "user_agent", "protocol_header", "body_shape", "endpoint", "prompt_marker", "unknown"]);

/** Allowlist narrowing for persisted client labels — never raw detection input. */
export function mapClientName(value: string | null | undefined): ClientName {
  return value !== null && value !== undefined && KNOWN_CLIENT_NAMES.has(value) ? (value as ClientName) : "unknown";
}

/** Allowlist narrowing for persisted client labels — never raw detection input. */
export function mapClientSource(value: string | null | undefined): ClientDetectionSource {
  return value !== null && value !== undefined && KNOWN_CLIENT_SOURCES.has(value) ? (value as ClientDetectionSource) : "unknown";
}

/** Canonical "YYYY-MM-DD HH:MM:SS" (UTC) timestamp — same shape as legacy rows. */
export function formatUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}


export function orZero(value: number | null | undefined): number {
  return value !== null && value !== undefined && Number.isFinite(value) ? value : 0;
}

const PERIOD_OFFSETS_MS: Readonly<Record<UsagePeriod, number>> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
  "30d": 2_592_000_000,
  all: 0,
};

export function periodStartUtc(period: UsagePeriod): string {
  return period === "all" ? "1970-01-01T00:00:00.000Z" : formatUtc(Date.now() - PERIOD_OFFSETS_MS[period]);
}

export function utcDayBounds(nowMs = Date.now()): { readonly start: string; readonly end: string } {
  const startMs = new Date(nowMs);
  startMs.setUTCHours(0, 0, 0, 0);
  return { start: formatUtc(startMs.getTime()), end: formatUtc(startMs.getTime() + 86_400_000) };
}
export function utcMonthBounds(nowMs = Date.now()): { readonly start: string; readonly end: string } {
  const date = new Date(nowMs);
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return { start: formatUtc(start.getTime()), end: formatUtc(end.getTime()) };
}


export function runtimeError(message: string): Error {
  return new Error(sanitizeMessage(message));
}

function tableExists(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;
}

// ────────────────────── Bounded write-behind buffer ─────────────────────────


// ────────────────────────── Telemetry writer ────────────────────────────────


// ────────────────────────── Metadata repository ─────────────────────────────



// ────────────────────────── Console log repository ──────────────────────────



// ─────────────────────────────── Retention ──────────────────────────────────


// ─────────────────────────────── Lifecycle ──────────────────────────────────


