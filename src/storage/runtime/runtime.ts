import { mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { sanitizeMessage, type ClientDetectionSource, type ClientName, type RequestTelemetryHandle, type RouteSwitch, type TelemetryFinish, type TelemetryWriter, type UsageDimension, type UsagePeriod } from "../../domain/contracts";
import { getPersistenceEnv, type PersistenceEnv } from "../main/env";

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

export interface ConsoleLogRow {
  readonly id: number;
  readonly ts: string;
  readonly level: string;
  readonly scope: string;
  readonly msg: string;
}

export interface ConsoleLogFilters {
  readonly level?: string;
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
  sumKeyTokens(keyId: string): { readonly dailyUsed: number; readonly allTimeUsed: number };
  invalidate(): void;
}

export interface ConsoleLogRepository {
  push(level: string, scope: string, msg: string): void;
  clear(): void;
  list(filters: ConsoleLogFilters): { items: ConsoleLogRow[]; nextCursor: number | null };
  after(afterId: number, limit: number): ConsoleLogRow[];
  onPush(listener: () => void): () => void;
}

export interface RuntimePersistence {
  readonly env: PersistenceEnv;
  readonly telemetry: TelemetryWriter;
  readonly metadata: RuntimeMetadataRepository;
  readonly consoleLogs: ConsoleLogRepository;
  readonly retain: (options?: { logRetentionDays?: number; assetRetentionDays?: number }) => RetentionResult;
  readonly startRetentionMaintenance: (intervalMs?: number) => { stop(): void };
  readonly flush: () => void;
  readonly pendingWrites: () => number;
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

function clearAllRuntimeTables(database: Database): void {
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
const KNOWN_CLIENT_SOURCES: ReadonlySet<string> = new Set(["explicit_header", "user_agent", "protocol_header", "prompt_marker", "unknown"]);

/** Allowlist narrowing for persisted client labels — never raw detection input. */
export function mapClientName(value: string | null | undefined): ClientName {
  return value !== null && value !== undefined && KNOWN_CLIENT_NAMES.has(value) ? (value as ClientName) : "unknown";
}

/** Allowlist narrowing for persisted client labels — never raw detection input. */
export function mapClientSource(value: string | null | undefined): ClientDetectionSource {
  return value !== null && value !== undefined && KNOWN_CLIENT_SOURCES.has(value) ? (value as ClientDetectionSource) : "unknown";
}

/** Canonical "YYYY-MM-DD HH:MM:SS" (UTC) timestamp — same shape as legacy rows. */
function formatUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

function parseUtc(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function orZero(value: number | null | undefined): number {
  return value !== null && value !== undefined && Number.isFinite(value) ? value : 0;
}

const PERIOD_OFFSETS_MS: Readonly<Record<UsagePeriod, number>> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
  "30d": 2_592_000_000,
  all: 0,
};

function periodStartUtc(period: UsagePeriod): string {
  return period === "all" ? "1970-01-01T00:00:00.000Z" : formatUtc(Date.now() - PERIOD_OFFSETS_MS[period]);
}

function utcDayBounds(nowMs = Date.now()): { readonly start: string; readonly end: string } {
  const startMs = new Date(nowMs);
  startMs.setUTCHours(0, 0, 0, 0);
  return { start: formatUtc(startMs.getTime()), end: formatUtc(startMs.getTime() + 86_400_000) };
}

/** "YYYY-MM-DD" date `days` in the past (UTC) — retention cutoff boundary. */
function cutoffDate(days: number): string {
  return new Date(Date.now() - days * PERIOD_OFFSETS_MS["24h"]).toISOString().slice(0, 10);
}

function runtimeError(message: string): Error {
  return new Error(sanitizeMessage(message));
}

function tableExists(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;
}

// ────────────────────── Bounded write-behind buffer ─────────────────────────

type SqlValue = string | number | null;

interface QueuedWrite {
  readonly sql: string;
  readonly params: readonly SqlValue[];
}

const FLUSH_THRESHOLD = 64;
const FLUSH_INTERVAL_MS = 20;
const FLUSH_RETRY_MS = 1_000;
const MAX_BUFFERED_WRITES = 256;

interface WriteBuffer {
  enqueue(sql: string, params: readonly SqlValue[]): void;
  flush(): void;
  pending(): number;
  close(): void;
}

function createWriteBuffer(getDb: () => Database): WriteBuffer {
  let queue: QueuedWrite[] = [];
  let flushTimer: Timer | null = null;
  let retryTimer: Timer | null = null;
  let closed = false;

  const scheduleFlush = (): void => {
    if (flushTimer === null) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flush();
      }, FLUSH_INTERVAL_MS);
      flushTimer.unref?.();
    }
  };

  const flush = (): void => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    try {
      const db = getDb();
      const applyBatch = db.transaction((rows: QueuedWrite[]) => {
        for (const row of rows) db.query(row.sql).run(...row.params);
      });
      applyBatch(batch);
    } catch {
      // Telemetry is best-effort: re-queue the same batch (SQLite batches are
      // atomic, so nothing was half-applied) and retry with backoff. The
      // buffer stays bounded — the same rows are retried, never new ones.
      queue = [...batch, ...queue];
      if (!closed && retryTimer === null) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          flush();
        }, FLUSH_RETRY_MS);
        retryTimer.unref?.();
      }
    }
  };

  return {
    enqueue(sql: string, params: readonly SqlValue[]): void {
      if (closed) return;
      queue.push({ sql, params });
      if (queue.length >= FLUSH_THRESHOLD) flush();
      if (queue.length > MAX_BUFFERED_WRITES) {
        // Hard bound: never let the queue grow unbounded under a stall.
        queue.splice(0, queue.length - MAX_BUFFERED_WRITES);
      }
      scheduleFlush();
    },
    flush,
    pending(): number {
      return queue.length;
    },
    close(): void {
      closed = true;
      flush();
      // A closed persistence instance has no future retry owner. Drop any
      // batch that could not be written so shutdown cannot retain telemetry.
      queue = [];
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    },
  };
}

// ────────────────────────── Telemetry writer ────────────────────────────────

const INSERT_SQL = `INSERT INTO request_history (
  trace_id, endpoint, surface, api_key_id, api_key_prefix, provider, model, status, error_kind, stream,
  started_at, finished_at, duration_ms, input_tokens, output_tokens, cached_tokens, cache_write_tokens,
  reasoning_tokens, total_tokens, usage_source, client_name, client_source, message_count, tool_count, image_count, tfft_ms, client_ip
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const UPSERT_SQL = `${INSERT_SQL} ON CONFLICT(trace_id) DO UPDATE SET
  endpoint = excluded.endpoint, surface = excluded.surface, provider = excluded.provider, model = excluded.model,
  status = excluded.status, error_kind = excluded.error_kind, stream = excluded.stream,
  finished_at = excluded.finished_at, duration_ms = excluded.duration_ms,
  input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
  cached_tokens = excluded.cached_tokens, cache_write_tokens = excluded.cache_write_tokens,
  reasoning_tokens = excluded.reasoning_tokens, total_tokens = excluded.total_tokens,
  usage_source = excluded.usage_source, client_name = excluded.client_name, client_source = excluded.client_source,
  message_count = excluded.message_count, tool_count = excluded.tool_count, image_count = excluded.image_count,
  tfft_ms = excluded.tfft_ms, client_ip = excluded.client_ip`;

export function createRuntimeTelemetryWriter(buffer: WriteBuffer, isTraceIdUnique: () => boolean, invalidateQueryCaches: () => void): TelemetryWriter {
  return {
    start(input: Parameters<TelemetryWriter["start"]>[0]): RequestTelemetryHandle {
      const requestId = input.requestId;
      const clientName = mapClientName(input.clientName);
      const clientSource = mapClientSource(input.clientSource);
      const startedMs = parseUtc(input.startedAt) ?? Date.now();
      const startedAt = formatUtc(startedMs);
      let finished = false;
      let tfftMs: number | null = null;

      const recordFirstToken = (): void => {
        if (tfftMs === null) tfftMs = Math.max(0, Date.now() - startedMs);
      };

      const finish = async (result: TelemetryFinish): Promise<void> => {
        if (finished) return;
        finished = true;
        const endedMs = Date.now();
        const finishedAt = formatUtc(endedMs);
        const usage = result.usage;
        const params: SqlValue[] = [
          requestId,
          input.endpoint,
          input.surface,
          input.apiKeyId,
          input.apiKeyPrefix,
          result.providerId,
          result.model,
          result.statusCode,
          result.errorKind,
          result.mode === "stream" ? 1 : 0,
          startedAt,
          finishedAt,
          Math.max(0, endedMs - startedMs),
          usage?.inputTokens ?? null,
          usage?.outputTokens ?? null,
          usage?.cacheReadTokens ?? null,
          usage?.cacheWriteTokens ?? null,
          null, // reasoning_tokens — legacy column, no runtime source
          usage?.totalTokens ?? null,
          usage?.source ?? "unknown",
          clientName,
          clientSource,
          result.messageCount,
          result.toolCount,
          result.imageCount,
          tfftMs,
          input.clientIp ?? null,
        ];
        buffer.enqueue(isTraceIdUnique() ? UPSERT_SQL : INSERT_SQL, params);
      };

      return {
        requestId,
        recordSwitch() {},
        recordFirstToken,
        finish,
      };
    },
  };
}

// ────────────────────────── Metadata repository ─────────────────────────────

interface RequestHistoryRow {
  id: number;
  trace_id: string;
  endpoint: string;
  surface: string;
  api_key_id: string | null;
  api_key_prefix: string | null;
  provider: string | null;
  model: string | null;
  status: number | null;
  error_kind: string | null;
  stream: number | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number | null;
  usage_source: string | null;
  client_name: string | null;
  client_source: string | null;
  message_count: number | null;
  tool_count: number | null;
  image_count: number | null;
  tfft_ms: number | null;
  client_ip: string | null;
}

const REQUEST_COLUMNS = `id, trace_id, endpoint, surface, api_key_id, api_key_prefix, provider, model, status, error_kind,
  stream, started_at, finished_at, duration_ms, input_tokens, output_tokens, cached_tokens, cache_write_tokens,
  reasoning_tokens, total_tokens, usage_source, client_name, client_source, message_count, tool_count, image_count, tfft_ms, client_ip`;

function toRuntimeRow(row: RequestHistoryRow): RuntimeRequestRow {
  return {
    id: row.id,
    requestId: row.trace_id,
    endpoint: row.endpoint,
    surface: row.surface,
    apiKeyId: row.api_key_id,
    apiKeyPrefix: row.api_key_prefix,
    provider: row.provider,
    model: row.model,
    status: row.status,
    errorKind: row.error_kind,
    mode: row.stream === 1 ? "stream" : "non_stream",
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cachedTokens: row.cached_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    reasoningTokens: row.reasoning_tokens,
    totalTokens: row.total_tokens,
    usageSource: row.usage_source ?? "unknown",
    clientName: mapClientName(row.client_name),
    clientSource: mapClientSource(row.client_source),
    messageCount: orZero(row.message_count),
    toolCount: orZero(row.tool_count),
    imageCount: orZero(row.image_count),
    tfftMs: row.tfft_ms,
    clientIp: row.client_ip,
  };
}

/** Bounded TTL cache for aggregate queries — console polling only, never bodies. */
class BoundedTtlCache {
  private readonly rows = new Map<string, { at: number; value: unknown }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  get<V>(key: string, compute: () => V): V {
    const hit = this.rows.get(key);
    if (hit !== undefined && Date.now() - hit.at < this.ttlMs) {
      // Refresh insertion order so recently-accessed entries survive eviction.
      this.rows.delete(key);
      this.rows.set(key, hit);
      return hit.value as V;
    }
    const value = compute();
    if (this.rows.size >= this.maxEntries) {
      // Evict the oldest-inserted entry (V8 Map preserves insertion order)
      // instead of clearing the entire cache — avoids a flash-crowd miss storm.
      const oldest = this.rows.keys().next();
      if (!oldest.done) this.rows.delete(oldest.value as string);
    }
    this.rows.set(key, { at: Date.now(), value });
    return value;
  }

  clear(): void {
    this.rows.clear();
  }
}

/**
 * Maximum chart buckets per period. Bucketings is in SQLite, so the response
 * is bounded by the number of distinct buckets, never by the number of rows
 * in the window. `"all"` uses daily granularity; retention (clamped ≤ 365d)
 * plus this window keeps that output bounded. All other periods naturally
 * produce far fewer buckets (1h: 60, 24h: 24, 7d: 56, 30d: 30), so the cap
 * only ever truncates pathological all-time histories.
 */
const MAX_CHART_BUCKETS = 400;

/** Cap for per provider × model aggregate rows (distinct combos only). */
const MAX_PROVIDER_MODEL_TOTALS = 500;

/**
 * SQLite expression producing the chart bucket label for each period, keeping
 * the previous `YYYY-MM-DD HH:MM` label semantics used by the dashboard:
 * `1h` → minute buckets, `24h` → hourly, `7d` → 3-hour slots aligned to
 * midnight UTC, `30d`/`all` → daily, ascending order. Bucketing in SQL means
 * the chart query materializes at most one row per bucket instead of one row
 * per request.
 */
function chartBucketExpr(period: UsagePeriod): string {
  switch (period) {
    case "all":
    case "30d":
      return "substr(started_at, 1, 10)";
    case "1h":
      return "substr(started_at, 1, 16)";
    case "24h":
      return "substr(started_at, 1, 13) || ':00'";
    default: // "7d": three-hour slots aligned to midnight UTC
      return "substr(started_at, 1, 11) || printf('%02d', (CAST(substr(started_at, 12, 2) AS INTEGER) / 3) * 3) || ':00'";
  }
}


export function createRuntimeMetadataRepository(getDb: () => Database, flushBeforeRead: () => void): RuntimeMetadataRepository {
  const cache = new BoundedTtlCache(2_000, 32);

  const invalidate = (): void => cache.clear();

  return {
    queryRequests(filters: RuntimeRequestFilters): RuntimeRequestPage {
      flushBeforeRead();
      // Request history is a completed-request view. Rows without a terminal
      // status are legacy/in-flight artifacts and must not consume the page or
      // cursor returned to the dashboard.
      const clauses: string[] = ["status IS NOT NULL", "status > 0"];
      const params: Array<string | number> = [];
      if (filters.cursor !== undefined) {
        clauses.push("id < ?");
        params.push(filters.cursor);
      }
      if (filters.provider) {
        clauses.push("provider = ?");
        params.push(filters.provider);
      }
      if (filters.model) {
        clauses.push("model = ?");
        params.push(filters.model);
      }
      if (filters.key) {
        clauses.push("api_key_prefix = ?");
        params.push(filters.key);
      }
      if (filters.status !== undefined) {
        clauses.push("status = ?");
        params.push(filters.status);
      }
      if (filters.stream !== undefined) {
        clauses.push("stream = ?");
        params.push(filters.stream ? 1 : 0);
      }
      if (filters.q) {
        clauses.push("trace_id LIKE ?");
        params.push(`%${filters.q}%`);
      }
      if (filters.clientIp) {
        clauses.push("client_ip = ?");
        params.push(filters.clientIp);
      }
      const boundedLimit = Math.min(Math.max(Math.floor(filters.limit ?? 50), 1), 100);
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = getDb()
        .query(`SELECT ${REQUEST_COLUMNS} FROM request_history ${where} ORDER BY id DESC LIMIT ?`)
        .all(...params, boundedLimit + 1) as RequestHistoryRow[];
      const hasMore = rows.length > boundedLimit;
      const visible = hasMore ? rows.slice(0, boundedLimit) : rows;
      const items = visible.map(toRuntimeRow);
      return { items, nextCursor: hasMore ? (visible.at(-1)?.id ?? null) : null };
    },
    getRequestById(id: number): RuntimeRequestRow | null {
      flushBeforeRead();
      const row = getDb().query(`SELECT ${REQUEST_COLUMNS} FROM request_history WHERE id = ?`).get(id) as RequestHistoryRow | null;
      return row ? toRuntimeRow(row) : null;
    },
    querySummary(period: UsagePeriod): UsageSummary {
      return cache.get(`summary:${period}`, () => {
        flushBeforeRead();
        const row = getDb()
          .query(
            `SELECT
              COUNT(*) AS requests,
              COALESCE(SUM(input_tokens), 0) AS inputTokens,
              COALESCE(SUM(cached_tokens), 0) AS cachedTokens,
              COALESCE(SUM(output_tokens), 0) AS outputTokens,
              COALESCE(SUM(CASE WHEN status >= 400 AND status NOT IN (499, 500, 502) THEN 1 ELSE 0 END), 0) AS errors,
              AVG(duration_ms) AS avgDurationMs
            FROM request_history WHERE started_at >= ?`,
          )
          .get(periodStartUtc(period)) as { requests: number; inputTokens: number | null; cachedTokens: number | null; outputTokens: number | null; errors: number; avgDurationMs: number | null };
        return {
          requests: row.requests,
          inputTokens: orZero(row.inputTokens),
          cachedTokens: orZero(row.cachedTokens),
          outputTokens: orZero(row.outputTokens),
          errors: row.errors,
          avgDurationMs: row.avgDurationMs !== null ? Math.round(row.avgDurationMs) : 0,
        };
      });
    },
    queryCache(period: UsagePeriod): UsageCacheSummary {
      return cache.get(`cache:${period}`, () => {
        flushBeforeRead();
        const rows = getDb()
          .query(
            `SELECT CASE
              WHEN model IS NOT NULL AND provider IS NOT NULL AND model LIKE provider || '/%' THEN model
              ELSE COALESCE(provider || '/' || model, COALESCE(model, provider, 'unknown'))
            END AS name,
            COUNT(*) AS requests,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
            COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens
            FROM request_history WHERE started_at >= ? GROUP BY name ORDER BY cached_tokens DESC, input_tokens DESC`,
          )
          .all(periodStartUtc(period)) as Array<{ name: string; requests: number; input_tokens: number | null; cached_tokens: number | null; cache_write_tokens: number | null }>;
        const mapped: UsageCacheRow[] = rows.map((row) => {
          const inputTokens = orZero(row.input_tokens);
          const cachedTokens = orZero(row.cached_tokens);
          return {
            name: row.name,
            requests: row.requests,
            inputTokens,
            cachedTokens,
            cacheWriteTokens: orZero(row.cache_write_tokens),
            hitRate: inputTokens > 0 ? (cachedTokens / inputTokens) * 100 : 0,
          };
        });
        const inputTokens = mapped.reduce((sum, row) => sum + row.inputTokens, 0);
        const cachedTokens = mapped.reduce((sum, row) => sum + row.cachedTokens, 0);
        return {
          inputTokens,
          cachedTokens,
          cacheWriteTokens: mapped.reduce((sum, row) => sum + row.cacheWriteTokens, 0),
          hitRate: inputTokens > 0 ? (cachedTokens / inputTokens) * 100 : 0,
          rows: mapped,
        };
      });
    },
    queryChart(period: UsagePeriod): ChartBucket[] {
      return cache.get(`chart:${period}`, () => {
        flushBeforeRead();
        // Bucketing happens in SQLite (see chartBucketExpr) so the response is
        // bounded by the distinct bucket count, never by the window's row count;
        // only the most recent MAX_CHART_BUCKETS buckets are returned.
        const rows = getDb()
          .query(
            `SELECT ${chartBucketExpr(period)} AS t,
              COUNT(*) AS requests,
              COALESCE(SUM(input_tokens), 0) AS input,
              COALESCE(SUM(cached_tokens), 0) AS cached,
              COALESCE(SUM(output_tokens), 0) AS output
             FROM request_history
             WHERE started_at >= ?
             GROUP BY t
             ORDER BY t DESC
             LIMIT ${MAX_CHART_BUCKETS}`,
          )
          .all(periodStartUtc(period)) as ChartBucket[];
        return rows.reverse(); // most recent first in SQL → ascending for the UI
      });
    },
    queryBy(dimension: UsageDimension, period: UsagePeriod): UsageByRow[] {
      const cacheKey = `by:${dimension}:${period}`;
      return cache.get(cacheKey, () => {
        flushBeforeRead();
        const column = dimension === "model" ? "model" : dimension === "provider" ? "provider" : "api_key_prefix";
        const fallback = dimension === "key" ? "anonymous" : "unknown";
        return getDb()
          .query(
            `SELECT
              COALESCE(${column}, ?) AS name,
              COUNT(*) AS requests,
              COALESCE(SUM(input_tokens), 0) AS input,
              COALESCE(SUM(output_tokens), 0) AS output,
              COALESCE(SUM(cached_tokens), 0) AS cached,
              COALESCE(SUM(total_tokens), 0) AS total,
              COALESCE(SUM(CASE WHEN status >= 400 AND status NOT IN (499, 500, 502) THEN 1 ELSE 0 END), 0) AS errors,
              NULL AS costUsd
            FROM request_history
            WHERE started_at >= ?
            GROUP BY name
            ORDER BY total DESC
            LIMIT 20`,
          )
          .all(fallback, periodStartUtc(period)) as UsageByRow[];
      });
    },
    queryProviderModelTotals(period: UsagePeriod): ProviderModelTotalsRow[] {
      flushBeforeRead();
      // Aggregated entirely in SQLite; the cap bounds the response to the
      // top distinct provider × model combos by input tokens. No in-tree
      // consumer relies on the full combo list.
      return getDb()
        .query(
          `SELECT provider, model, COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens
           FROM request_history
           WHERE started_at >= ?
           GROUP BY provider, model
           ORDER BY inputTokens DESC
           LIMIT ${MAX_PROVIDER_MODEL_TOTALS}`,
        )
        .all(periodStartUtc(period)) as ProviderModelTotalsRow[];
    },
    queryModelTokenTotals(period: UsagePeriod): ModelTokenTotalsRow[] {
      flushBeforeRead();
      return getDb()
        .query(
          `SELECT model, provider, COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens
           FROM request_history
           WHERE started_at >= ? AND model IS NOT NULL
           GROUP BY model, provider
           ORDER BY inputTokens DESC
           LIMIT ${MAX_PROVIDER_MODEL_TOTALS}`,
        )
        .all(periodStartUtc(period)) as ModelTokenTotalsRow[];
    },
    queryProviderToday(): ProviderTodayRow[] {
      flushBeforeRead();
      const bounds = utcDayBounds();
      return getDb()
        .query(
          `SELECT
            provider,
            COUNT(*) AS requests,
            COALESCE(SUM(input_tokens), 0) AS input,
            COALESCE(SUM(cached_tokens), 0) AS cached,
            COALESCE(SUM(output_tokens), 0) AS output,
            COALESCE(SUM(CASE WHEN status >= 400 AND status NOT IN (499, 500, 502) THEN 1 ELSE 0 END), 0) AS errors
          FROM request_history
          WHERE provider IS NOT NULL AND started_at >= ? AND started_at < ?
          GROUP BY provider`,
        )
        .all(bounds.start, bounds.end) as ProviderTodayRow[];
    },
    queryLastProviderError(provider: string): string | null {
      flushBeforeRead();
      const row = getDb().query("SELECT error_kind FROM request_history WHERE provider = ? AND status >= 400 ORDER BY id DESC LIMIT 1").get(provider) as { error_kind: string | null } | null;
      return row?.error_kind ?? null;
    },
    queryIpSummary(limit: number): IpSummaryRow[] {
      flushBeforeRead();
      const cap = Math.max(1, Math.min(500, Math.floor(limit)));
      return getDb()
        .query(
          `SELECT
            client_ip AS ip,
            COUNT(*) AS requests,
            COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors,
            MAX(started_at) AS lastRequestAt,
            COALESCE(SUM(input_tokens), 0) AS inputTokens,
            COALESCE(SUM(output_tokens), 0) AS outputTokens
          FROM request_history
          WHERE client_ip IS NOT NULL AND client_ip != ''
          GROUP BY client_ip
          ORDER BY lastRequestAt DESC
          LIMIT ?`,
        )
        .all(cap) as IpSummaryRow[];
    },
    sumKeyTokens(keyId: string): { readonly dailyUsed: number; readonly allTimeUsed: number } {
      flushBeforeRead();
      const bounds = utcDayBounds();
      const row = getDb().query("SELECT COALESCE(SUM(total_tokens), 0) AS allTimeUsed, COALESCE(SUM(CASE WHEN started_at >= ? AND started_at < ? THEN total_tokens ELSE 0 END), 0) AS dailyUsed FROM request_history WHERE api_key_id = ?").get(bounds.start, bounds.end, keyId) as { dailyUsed: number; allTimeUsed: number };
      return { dailyUsed: row.dailyUsed, allTimeUsed: row.allTimeUsed };
    },
    invalidate,
  };
}

// ────────────────────────── Console log repository ──────────────────────────


export function createConsoleLogRepository(buffer: WriteBuffer, getDb: () => Database, flushBeforeRead: () => void): ConsoleLogRepository {
  const pushListeners = new Set<() => void>();
  const MAX_PUSH_LISTENERS = 64;
  return {
    push(level: string, scope: string, msg: string): void {
      const bounded = sanitizeMessage(msg);
      buffer.enqueue("INSERT INTO console_logs (ts, level, scope, msg) VALUES (?, ?, ?, ?)", [formatUtc(Date.now()), level, scope, bounded]);
      // Notify SSE subscribers immediately so the log stream doesn't wait for the next tick.
      for (const listener of pushListeners) listener();
    },
    clear(): void {
      buffer.flush();
      getDb().query("DELETE FROM console_logs").run();
    },
    list(filters: ConsoleLogFilters): { items: ConsoleLogRow[]; nextCursor: number | null } {
      flushBeforeRead();
      const clauses: string[] = [];
      const params: Array<string | number> = [];
      if (filters.cursor !== undefined) {
        clauses.push("id < ?");
        params.push(filters.cursor);
      }
      if (filters.level) {
        clauses.push("level = ?");
        params.push(filters.level);
      }
      if (filters.scope) {
        clauses.push("scope = ?");
        params.push(filters.scope);
      }
      const boundedLimit = Math.min(Math.max(Math.floor(filters.limit ?? 100), 1), 200);
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = getDb()
        .query(`SELECT id, ts, level, scope, msg FROM console_logs ${where} ORDER BY id DESC LIMIT ?`)
        .all(...params, boundedLimit + 1) as ConsoleLogRow[];
      const hasMore = rows.length > boundedLimit;
      const visible = hasMore ? rows.slice(0, boundedLimit) : rows;
      return { items: visible, nextCursor: hasMore ? (visible.at(-1)?.id ?? null) : null };
    },
    after(afterId: number, limit: number): ConsoleLogRow[] {
      flushBeforeRead();
      const cursor = Number.isFinite(afterId) ? Math.max(Math.floor(afterId), 0) : 0;
      const bounded = Math.min(Math.max(Math.floor(limit), 1), 200);
      return getDb()
        .query("SELECT id, ts, level, scope, msg FROM console_logs WHERE id > ? ORDER BY id ASC LIMIT ?")
        .all(cursor, bounded) as ConsoleLogRow[];
    },
    onPush(listener: () => void): () => void {
      if (pushListeners.size >= MAX_PUSH_LISTENERS) {
        const oldest = pushListeners.keys().next();
        if (!oldest.done) pushListeners.delete(oldest.value as () => void);
      }
      pushListeners.add(listener);
      return () => { pushListeners.delete(listener); };
    },
  };
}

// ─────────────────────────────── Retention ──────────────────────────────────

const RETENTION_BATCH_SIZE = 500;
const MAX_CONSOLE_LOG_ROWS = 10_000;

/** Allowlist of tables and columns valid for batched retention deletes. */
const RETENTION_TABLES = new Set(["request_history", "console_logs", "model_probes", "request_details", "request_tool_calls", "request_assets"]);
const RETENTION_COLUMNS = new Set(["started_at", "created_at", "ts"]);

function deleteBatched(db: Database, table: string, column: string, cutoff: string): number {
  if (!RETENTION_TABLES.has(table) || !RETENTION_COLUMNS.has(column)) {
    throw new Error(`Refusing to delete from unknown table: ${table}.${column}`);
  }
  let removed = 0;
  for (;;) {
    const result = db.query(`DELETE FROM ${table} WHERE ${column} < ? LIMIT ${RETENTION_BATCH_SIZE}`).run(cutoff);
    removed += result.changes;
    if (result.changes < RETENTION_BATCH_SIZE) break;
  }
  return removed;
}

function deleteConsoleLogsBeyondLimit(db: Database): number {
  const boundary = db.query("SELECT id FROM console_logs ORDER BY id DESC LIMIT 1 OFFSET ?").get(MAX_CONSOLE_LOG_ROWS) as { id: number } | null;
  if (boundary === null) return 0;
  let removed = 0;
  for (;;) {
    const result = db.query(`DELETE FROM console_logs WHERE id < ? LIMIT ${RETENTION_BATCH_SIZE}`).run(boundary.id);
    removed += result.changes;
    if (result.changes < RETENTION_BATCH_SIZE) return removed;
  }
}

/**
 * Retention applies the configured date cutoffs to runtime telemetry only:
 * request history and console logs use `logRetentionDays`; legacy detail,
 * tool-call, and asset rows/files use `assetRetentionDays`. Configuration
 * state is never touched. Safe to run repeatedly (idempotent). Console logs
 * are also capped to MAX_CONSOLE_LOG_ROWS so frequent runtime events cannot
 * grow the database indefinitely. All deletes and asset-file unlinks run in
 * bounded batches (RETENTION_BATCH_SIZE rows at
 * a time) so cleanup memory stays constant regardless of history size.
 */
export function retainRuntimeData(
  getDb: () => Database,
  options: { logRetentionDays: number; assetRetentionDays: number; assetDir: string },
): RetentionResult {
  const db = getDb();
  const logCutoff = cutoffDate(Math.min(Math.max(Math.floor(options.logRetentionDays), 1), 365));
  const assetCutoff = cutoffDate(Math.min(Math.max(Math.floor(options.assetRetentionDays), 1), 365));
  const counts = { historyRemoved: 0, consoleLogsRemoved: 0, detailsRemoved: 0, toolCallsRemoved: 0, assetFilesRemoved: 0 };

  const apply = db.transaction((): void => {
    counts.historyRemoved += deleteBatched(db, "request_history", "started_at", logCutoff);
    if (tableExists(db, "console_logs")) {
      counts.consoleLogsRemoved += deleteBatched(db, "console_logs", "ts", logCutoff);
      counts.consoleLogsRemoved += deleteConsoleLogsBeyondLimit(db);
    }

    // Legacy tables: cleaned when they already exist, never written.
    if (tableExists(db, "request_details")) counts.detailsRemoved += deleteBatched(db, "request_details", "created_at", assetCutoff);
    if (tableExists(db, "request_tool_calls")) counts.toolCallsRemoved += deleteBatched(db, "request_tool_calls", "created_at", assetCutoff);
    if (tableExists(db, "request_assets")) {
      // Iterate stale asset rows in bounded id batches so cleanup never
      // materializes the full path list or row set at once; each batch's
      // backing files are unlinked before its rows are deleted.
      const root = resolve(options.assetDir);
      let lastId = 0;
      for (;;) {
        const rows = db
          .query(`SELECT id, storage_path FROM request_assets WHERE created_at < ? AND id > ? ORDER BY id ASC LIMIT ${RETENTION_BATCH_SIZE}`)
          .all(assetCutoff, lastId) as Array<{ id: number; storage_path: string | null }>;
        if (rows.length === 0) break;
        for (const row of rows) {
          if (row.storage_path === null || row.storage_path.length === 0) continue;
          try {
            const absolute = resolve(row.storage_path);
            // Only ever delete files inside the asset directory on every OS.
            const relativePath = relative(root, absolute);
            if (relativePath.length === 0 || relativePath.startsWith("..") || isAbsolute(relativePath)) continue;
            if (statSync(absolute).isFile()) {
              unlinkSync(absolute);
              counts.assetFilesRemoved += 1;
            }
          } catch {
            // already gone or unreadable — best effort
          }
        }
        db.query(`DELETE FROM request_assets WHERE id IN (${rows.map(() => "?").join(",")})`).run(...rows.map((row) => row.id));
        const lastRow = rows.at(-1);
        if (lastRow === undefined) break;
        lastId = lastRow.id;
      }
    }
  });
  apply();
  return counts;
}

// ─────────────────────────────── Lifecycle ──────────────────────────────────


export function createRuntimePersistence(env: PersistenceEnv = getPersistenceEnv()): RuntimePersistence {
  let db: Database | null = null;
  let closed = false;
  let traceIdUnique = false;

  const getDb = (): Database => {
    if (closed) throw runtimeError("runtime database is closed");
    if (db === null) {
      try {
        mkdirSync(dirname(env.runtimeDbPath), { recursive: true });
        const opened = new Database(env.runtimeDbPath, { create: true });
        opened.exec("PRAGMA journal_mode=WAL");
        // NORMAL skips an fsync per commit (WAL still fsyncs at checkpoints):
        // the documented telemetry durability tradeoff. Config state stays at
        // FULL in `config.ts`.
        opened.exec("PRAGMA synchronous=NORMAL");
        opened.exec("PRAGMA busy_timeout=5000");
        traceIdUnique = ensureRuntimeSchema(opened).traceIdUnique;
        db = opened;
      } catch (error) {
        throw runtimeError(`runtime database unavailable: ${error instanceof Error ? error.message : "open failed"}`);
      }
    }
    return db;
  };

  const buffer = createWriteBuffer(getDb);
  const metadata = createRuntimeMetadataRepository(getDb, buffer.flush);
  const consoleLogs = createConsoleLogRepository(buffer, getDb, buffer.flush);
  const isTraceIdUnique = (): boolean => traceIdUnique;

  const retain = (options?: { logRetentionDays?: number; assetRetentionDays?: number }): RetentionResult => {
    buffer.flush();
    const settings = retentionDefaultProvider ? retentionDefaultProvider() : { logRetentionDays: env.logRetentionDays, assetRetentionDays: env.assetRetentionDays };
    return retainRuntimeData(getDb, {
      logRetentionDays: options?.logRetentionDays ?? settings.logRetentionDays,
      assetRetentionDays: options?.assetRetentionDays ?? settings.assetRetentionDays,
      assetDir: env.assetDir,
    });
  };

  return {
    env,
    telemetry: createRuntimeTelemetryWriter(buffer, isTraceIdUnique, metadata.invalidate),
    metadata,
    consoleLogs,
    retain,
    startRetentionMaintenance(intervalMs = 6 * 3_600_000): { stop(): void } {
      let timer: Timer | null = null;
      let stopped = false;
      const run = (): void => {
        if (stopped) return;
        try {
          retain();
        } catch {
          // never crash the process over telemetry cleanup
        }
      };
      try {
        run();
      } catch {
        // never crash boot
      }
      timer = setInterval(run, intervalMs);
      timer.unref?.();
      return {
        stop(): void {
          stopped = true;
          if (timer !== null) {
            clearInterval(timer);
            timer = null;
          }
        },
      };
    },
    flush: () => buffer.flush(),
    pendingWrites: () => buffer.pending(),
    checkpoint(): void {
      db?.exec("PRAGMA wal_checkpoint(PASSIVE);");
    },
    db(): Database {
      return getDb();
    },
    closeForSwap(): void {
      // Drain the write-behind buffer so no queued telemetry is lost, then
      // close the old handle. The buffer instance survives — it still
      // references `getDb`, so a subsequent reopen() routes enqueues to the
      // new db. Unlike the terminal shutdown close(), the singleton stays
      // reopenable.
      buffer.flush();
      if (db) {
        try {
          db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        } catch {
          // mid-close — best effort
        }
        try {
          db.close();
        } catch {
          // already closed — best effort
        }
        db = null;
      }
      closed = false;
    },
    reopen(): void {
      // Re-open against the (possibly swapped) file and re-run schema setup.
      closed = false;
      traceIdUnique = ensureRuntimeSchema(getDb()).traceIdUnique;
    },
    resetAll(): void {
      buffer.flush();
      clearAllRuntimeTables(getDb());
      metadata.invalidate();
    },
    close(): void {
      if (closed) return;
      buffer.close();
      closed = true;
      if (db) {
        try {
          db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        } catch {
          // already closed or mid-shutdown — best effort
        }
        db.close();
        db = null;
      }
    },
  };
}

let retentionDefaultProvider: (() => { logRetentionDays: number; assetRetentionDays: number }) | null = null;

/**
 * Composition hook: point the maintenance/retention defaults at the config
 * settings repository (console-patched values are picked up on every run).
 */
export function setRetentionDefaults(provider: () => { logRetentionDays: number; assetRetentionDays: number }): void {
  retentionDefaultProvider = provider;
}

let singleton: RuntimePersistence | null = null;

/** Shared application instance; lazily opens on first access. */
export function getRuntimePersistence(): RuntimePersistence {
  if (singleton === null) singleton = createRuntimePersistence();
  return singleton;
}

/** Console-facing metadata accessor (delegates to the shared instance). */
export function getRuntimeMetadataRepository(): RuntimeMetadataRepository {
  return getRuntimePersistence().metadata;
}

/** Console-facing operational log accessor (delegates to the shared instance). */
export function getConsoleLogRepository(): ConsoleLogRepository {
  return getRuntimePersistence().consoleLogs;
}

/** Test-only: close the singleton so the next access re-opens (possibly at a re-pointed env). */
export function resetRuntimePersistenceForTests(): void {
  if (singleton) {
    try {
      singleton.close();
    } catch {
      // already closed — fine
    }
    singleton = null;
  }
}
