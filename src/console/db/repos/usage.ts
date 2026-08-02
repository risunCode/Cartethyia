/**
 * Request/usage history - persisted in `runtime.sqlite` (see
 * `../runtime-client.ts`), a database file separate from the config db so
 * high-frequency traffic writes never contend with API key/provider/settings
 * reads and writes. Inserts go through `../runtime-write-buffer.ts` (batched
 * commits); every read flushes that buffer first via `readRuntimeDb()` so a
 * request is visible immediately after it's tracked, not after the next
 * timed flush.
 */

import { getRuntimeDb } from "../runtime-client";
import { enqueueRuntimeWrite, readRuntimeDb } from "../runtime-write-buffer";
import { orZero } from "../../../utils/number-guards";
import { utcNow, utcDateOf, periodStartUtc, type UsagePeriod } from "../../../utils/date-utils";
import { providerRegistry } from "../../../upstream/providers";
import type { Provider } from "../../../upstream/providers";
import { TtlCache } from "../ttl-cache";

export { utcNow, utcDateOf, periodStartUtc, type UsagePeriod };

export interface UsageInsert {
  traceId: string;
  endpoint: string;
  surface: string;
  apiKeyId: string | null;
  apiKeyPrefix: string | null;
  provider: string | null;
  model: string | null;
  status: number;
  errorKind: string | null;
  stream: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  usageSource: string;
  meta: Record<string, unknown>;
}

// request_history.id is assigned here (not left to AUTOINCREMENT) so
// insertUsageHistory can return it synchronously without waiting for the
// batched write to actually commit - request_details/tool_calls/assets need
// it immediately to set their own foreign key. Seeded once per process from
// the durable max id; safe because the seed only ever runs before this
// process's first insert, when nothing is queued yet.
let nextHistoryId: number | null = null;

// Dashboard panels ask for the same aggregates independently. A short cache
// collapses duplicate scans while insertUsageHistory invalidates it immediately
// so active traffic remains visible without waiting for expiry.
const usageSummaryCache = new TtlCache<UsagePeriod, UsageSummary>(2_000, 8);
const usageCostCache = new TtlCache<UsagePeriod, UsageCost>(2_000, 8);
const usageChartCache = new TtlCache<UsagePeriod, ChartBucket[]>(2_000, 8);
const usageByCache = new TtlCache<string, UsageByRow[]>(2_000, 24);
const usageCacheCache = new TtlCache<UsagePeriod, UsageCacheSummary>(2_000, 8);

function clearUsageQueryCaches(): void {
  usageSummaryCache.clear();
  usageCostCache.clear();
  usageChartCache.clear();
  usageByCache.clear();
  usageCacheCache.clear();
}

function allocateHistoryId(): number {
  if (nextHistoryId === null) {
    const row = getRuntimeDb().query("SELECT COALESCE(MAX(id), 0) AS maxId FROM request_history").get() as { maxId: number };
    nextHistoryId = row.maxId + 1;
  }
  const id = nextHistoryId;
  nextHistoryId += 1;
  return id;
}

export function insertUsageHistory(row: UsageInsert): number {
  clearUsageQueryCaches();
  const id = allocateHistoryId();
  enqueueRuntimeWrite(
    `INSERT INTO request_history (
      id, trace_id, endpoint, surface, api_key_id, api_key_prefix, provider, model, status, error_kind,
      stream, started_at, finished_at, duration_ms, input_tokens, output_tokens, cached_tokens,
      cache_write_tokens, reasoning_tokens, total_tokens, usage_source, meta_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, row.traceId, row.endpoint, row.surface, row.apiKeyId, row.apiKeyPrefix, row.provider, row.model,
      row.status, row.errorKind, row.stream ? 1 : 0, row.startedAt, row.finishedAt, row.durationMs,
      row.inputTokens, row.outputTokens, row.cachedTokens, row.cacheWriteTokens, row.reasoningTokens,
      row.totalTokens, row.usageSource, JSON.stringify(row.meta ?? {}),
    ],
  );
  if (row.apiKeyId) recordKeyTokenUsage(row.apiKeyId, orZero(row.inputTokens) + orZero(row.outputTokens));
  return id;
}

/** Deletes request-history rows older than a "YYYY-MM-DD" cutoff (retention). Returns the row count removed. */
export function deleteRequestHistoryOlderThan(cutoffDate: string): number {
  const changes = readRuntimeDb().query("DELETE FROM request_history WHERE started_at < ?").run(cutoffDate).changes;
  if (changes > 0) clearUsageQueryCaches();
  return changes;
}

/** Test-only: re-derive the id sequence from the (possibly freshly isolated) db. */
export function resetHistoryIdAllocatorForTests(): void {
  nextHistoryId = null;
}

export interface UsageSummary {
  requests: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  errors: number;
  avgDurationMs: number;
}

interface UsageSummaryRow {
  requests: number;
  inputTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
  errors: number;
  avgDurationMs: number | null;
}

export function queryUsageSummary(period: UsagePeriod): UsageSummary {
  return usageSummaryCache.get(period, () => {
    const row = readRuntimeDb()
      .query(
        `SELECT
          COUNT(*) AS requests,
          COALESCE(SUM(input_tokens), 0) AS inputTokens,
          COALESCE(SUM(cached_tokens), 0) AS cachedTokens,
          COALESCE(SUM(output_tokens), 0) AS outputTokens,
          COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors,
          AVG(duration_ms) AS avgDurationMs
        FROM request_history WHERE started_at >= ?`,
      )
      .get(periodStartUtc(period)) as UsageSummaryRow;
    return {
      requests: row.requests,
      inputTokens: orZero(row.inputTokens),
      cachedTokens: orZero(row.cachedTokens),
      outputTokens: orZero(row.outputTokens),
      errors: row.errors,
      avgDurationMs: row.avgDurationMs ? Math.round(row.avgDurationMs) : 0,
    };
  });
}

export interface UsageCacheRow {
  name: string;
  requests: number;
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  hitRate: number;
}

export interface UsageCacheSummary {
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  hitRate: number;
  rows: UsageCacheRow[];
}

export function queryUsageCache(period: UsagePeriod): UsageCacheSummary {
  return usageCacheCache.get(period, () => {
    const rows = readRuntimeDb().query(
      `SELECT CASE
          WHEN model IS NOT NULL AND provider IS NOT NULL AND model LIKE provider || '/%' THEN model
          ELSE COALESCE(provider || '/' || model, COALESCE(model, provider, 'unknown'))
        END AS name,
        COUNT(*) AS requests,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
        COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens
       FROM request_history WHERE started_at >= ? GROUP BY name ORDER BY cached_tokens DESC, input_tokens DESC`,
    ).all(periodStartUtc(period)) as Array<{ name: string; requests: number; input_tokens: number | null; cached_tokens: number | null; cache_write_tokens: number | null }>;
    const mapped = rows.map((row) => {
      const inputTokens = orZero(row.input_tokens);
      const cachedTokens = orZero(row.cached_tokens);
      return { name: row.name, requests: row.requests, inputTokens, cachedTokens, cacheWriteTokens: orZero(row.cache_write_tokens), hitRate: inputTokens > 0 ? (cachedTokens / inputTokens) * 100 : 0 };
    });
    const inputTokens = mapped.reduce((sum, row) => sum + row.inputTokens, 0);
    const cachedTokens = mapped.reduce((sum, row) => sum + row.cachedTokens, 0);
    return { inputTokens, cachedTokens, cacheWriteTokens: mapped.reduce((sum, row) => sum + row.cacheWriteTokens, 0), hitRate: inputTokens > 0 ? (cachedTokens / inputTokens) * 100 : 0, rows: mapped };
  });
}

export interface UsageCost {
  estimatedCostUsd: number;
  /** True when at least one matching request used a provider/model with no published per-token rate (subscription/aggregator providers), so the total under-counts those requests rather than guessing. */
  partial: boolean;
}

interface CostRow {
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

/**
 * Sum of each request's actual cost, using its own provider/model's real
 * per-token rate (`ProviderModelEntry.pricing`) rather than one blended
 * estimate across every request regardless of which model served it.
 */
export function queryUsageCost(period: UsagePeriod): UsageCost {
  return usageCostCache.get(period, () => {
    const rows = readRuntimeDb()
      .query("SELECT provider, model, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens FROM request_history WHERE started_at >= ? GROUP BY provider, model")
      .all(periodStartUtc(period)) as CostRow[];
    let estimatedCostUsd = 0;
    let partial = false;
    for (const row of rows) {
      const pricing = row.provider && row.model ? providerRegistry.get(row.provider as Provider["id"])?.models.resolve(row.model)?.pricing : undefined;
      if (!pricing) {
        partial = true;
        continue;
      }
      estimatedCostUsd += (orZero(row.input_tokens) * pricing.input + orZero(row.output_tokens) * pricing.output) / 1_000_000;
    }
    return { estimatedCostUsd, partial };
  });
}

export type ChartMetric = "requests" | "tokens" | "cached";

export interface ChartBucket {
  t: string;
  requests: number;
  input: number;
  cached: number;
  output: number;
}

function bucketOf(timestamp: string, period: UsagePeriod): string {
  if (period === "1h") return timestamp.slice(0, 16);
  if (period === "24h") return `${timestamp.slice(0, 13)}:00`;
  if (period === "30d") return timestamp.slice(0, 10);
  const hour = Number(timestamp.slice(11, 13));
  return `${timestamp.slice(0, 11)}${String(Math.floor(hour / 3) * 3).padStart(2, "0")}:00`;
}

interface ChartRow {
  started_at: string;
  input_tokens: number | null;
  cached_tokens: number | null;
  output_tokens: number | null;
}

export function queryUsageChart(period: UsagePeriod): ChartBucket[] {
  return usageChartCache.get(period, () => {
    const rows = readRuntimeDb()
      .query("SELECT started_at, input_tokens, cached_tokens, output_tokens FROM request_history WHERE started_at >= ?")
      .all(periodStartUtc(period)) as ChartRow[];
    const buckets = new Map<string, ChartBucket>();
    for (const row of rows) {
      const key = bucketOf(row.started_at, period);
      const bucket = buckets.get(key) ?? { t: key, requests: 0, input: 0, cached: 0, output: 0 };
      bucket.requests += 1;
      bucket.input += orZero(row.input_tokens);
      bucket.cached += orZero(row.cached_tokens);
      bucket.output += orZero(row.output_tokens);
      buckets.set(key, bucket);
    }
    return [...buckets.values()].sort((a, b) => a.t.localeCompare(b.t));
  });
}

export type UsageDimension = "model" | "provider" | "key";

export interface UsageByRow {
  name: string;
  requests: number;
  input: number;
  output: number;
  cached: number;
  total: number;
}

const DIMENSION_COLUMN: Record<UsageDimension, string> = {
  model: "model",
  provider: "provider",
  key: "api_key_prefix",
};
const DIMENSION_FALLBACK: Record<UsageDimension, string> = {
  model: "unknown",
  provider: "unknown",
  key: "anonymous",
};

export function queryUsageBy(dimension: UsageDimension, period: UsagePeriod): UsageByRow[] {
  const cacheKey = `${dimension}:${period}`;
  return usageByCache.get(cacheKey, () => {
    const column = DIMENSION_COLUMN[dimension];
  const fallback = DIMENSION_FALLBACK[dimension];
  const rows = readRuntimeDb()
    .query(
      `SELECT
        COALESCE(${column}, ?) AS name,
        COUNT(*) AS requests,
        COALESCE(SUM(input_tokens), 0) AS input,
        COALESCE(SUM(output_tokens), 0) AS output,
        COALESCE(SUM(cached_tokens), 0) AS cached,
        COALESCE(SUM(total_tokens), 0) AS total
      FROM request_history
      WHERE started_at >= ?
      GROUP BY name
      ORDER BY total DESC
      LIMIT 20`,
    )
    .all(fallback, periodStartUtc(period)) as UsageByRow[];
    return rows;
  });
}

export function resetUsageQueryCachesForTests(): void {
  clearUsageQueryCaches();
}

export interface UsageRequestFilters {
  cursor?: number;
  limit: number;
  provider?: string;
  model?: string;
  key?: string;
  status?: number;
  stream?: boolean;
  q?: string;
}

export interface UsageRequestRow {
  id: number;
  trace_id: string;
  endpoint: string;
  surface: string;
  api_key_prefix: string | null;
  api_key_id: string | null;
  provider: string | null;
  model: string | null;
  status: number | null;
  error_kind: string | null;
  stream: number;
  started_at: string;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  total_tokens: number | null;
  usage_source: string;
}

export function queryUsageRequests(filters: UsageRequestFilters): { items: UsageRequestRow[]; nextCursor: number | null } {
  const clauses: string[] = [];
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
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = readRuntimeDb()
    .query(
      `SELECT
        id, trace_id, endpoint, surface, api_key_prefix, api_key_id, provider, model, status, error_kind,
        stream, started_at, duration_ms, input_tokens, output_tokens, cached_tokens, total_tokens, usage_source
      FROM request_history ${where}
      ORDER BY id DESC
      LIMIT ?`,
    )
    .all(...params, filters.limit + 1) as UsageRequestRow[];
  const hasMore = rows.length > filters.limit;
  const visible = hasMore ? rows.slice(0, filters.limit) : rows;
  return { items: visible, nextCursor: hasMore ? visible.at(-1)!.id : null };
}

export function getUsageRequestById(id: number): Record<string, unknown> | null {
  const row = readRuntimeDb().query("SELECT * FROM request_history WHERE id = ?").get(id) as Record<string, unknown> | null;
  if (!row) return null;
  return {
    id: row.id,
    trace_id: row.trace_id,
    endpoint: row.endpoint,
    surface: row.surface,
    api_key_prefix: row.api_key_prefix,
    api_key_id: row.api_key_id,
    provider: row.provider,
    model: row.model,
    status: row.status,
    error_kind: row.error_kind,
    stream: row.stream,
    started_at: row.started_at,
    finished_at: row.finished_at,
    duration_ms: row.duration_ms,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cached_tokens: row.cached_tokens,
    cache_write_tokens: row.cache_write_tokens,
    reasoning_tokens: row.reasoning_tokens,
    total_tokens: row.total_tokens,
    usage_source: row.usage_source,
    meta_json: row.meta_json,
  };
}

export interface ProviderTodayRow {
  provider: string;
  requests: number;
  input: number;
  cached: number;
  output: number;
  errors: number;
}

export function queryProviderToday(): ProviderTodayRow[] {
  const today = new Date().toISOString().slice(0, 10);
  return readRuntimeDb()
    .query(
      `SELECT
        provider,
        COUNT(*) AS requests,
        COALESCE(SUM(input_tokens), 0) AS input,
        COALESCE(SUM(cached_tokens), 0) AS cached,
        COALESCE(SUM(output_tokens), 0) AS output,
        COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors
      FROM request_history
      WHERE provider IS NOT NULL AND substr(started_at, 1, 10) = ?
      GROUP BY provider`,
    )
    .all(today) as ProviderTodayRow[];
}

export function queryLastProviderError(provider: string): string | null {
  const row = readRuntimeDb()
    .query("SELECT error_kind FROM request_history WHERE provider = ? AND status >= 400 ORDER BY id DESC LIMIT 1")
    .get(provider) as { error_kind: string | null } | null;
  return row?.error_kind ?? null;
}

// ─────────────────── Daily/monthly token accumulator ──────────────────────
//
// sumDailyTokensForKey/sumMonthlyTokensForKey run on every request for a key
// with a configured daily/monthly limit (enforceProxyAuth, before the request
// is even dispatched) - a SQL SUM scanning that whole day's/month's history
// on every single request, growing more expensive the more a key is used
// within its window. An in-memory running total per key, updated the moment
// insertUsageHistory tracks a request (independent of when the write-behind
// buffer above actually commits, so it's always immediately consistent
// within this process), turns both into an O(1) map lookup. It's seeded from
// the durable table only once per key per UTC day/month boundary.

interface KeyTokenAccumulator {
  day: string;
  dailyTokens: number;
  month: string;
  monthlyTokens: number;
}

const keyAccumulators = new Map<string, KeyTokenAccumulator>();

function sumTokensFromDb(apiKeyId: string, clause: string, value: string): number {
  const row = readRuntimeDb()
    .query(`SELECT COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) AS total FROM request_history WHERE api_key_id = ? AND ${clause} = ?`)
    .get(apiKeyId, value) as { total: number };
  return row.total;
}

function ensureAccumulator(apiKeyId: string): KeyTokenAccumulator {
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  let acc = keyAccumulators.get(apiKeyId);
  if (!acc) {
    acc = {
      day: today,
      dailyTokens: sumTokensFromDb(apiKeyId, "substr(started_at, 1, 10)", today),
      month,
      monthlyTokens: sumTokensFromDb(apiKeyId, "substr(started_at, 1, 7)", month),
    };
    keyAccumulators.set(apiKeyId, acc);
    return acc;
  }
  if (acc.day !== today) {
    acc.day = today;
    acc.dailyTokens = sumTokensFromDb(apiKeyId, "substr(started_at, 1, 10)", today);
  }
  if (acc.month !== month) {
    acc.month = month;
    acc.monthlyTokens = sumTokensFromDb(apiKeyId, "substr(started_at, 1, 7)", month);
  }
  return acc;
}

function recordKeyTokenUsage(apiKeyId: string, tokens: number): void {
  if (tokens === 0) return;
  const acc = ensureAccumulator(apiKeyId);
  acc.dailyTokens += tokens;
  acc.monthlyTokens += tokens;
}

export function sumDailyTokensForKey(apiKeyId: string): number {
  return ensureAccumulator(apiKeyId).dailyTokens;
}

/** UTC calendar month token total for a key — mirrors daily limit boundaries. */
export function sumMonthlyTokensForKey(apiKeyId: string): number {
  return ensureAccumulator(apiKeyId).monthlyTokens;
}

/** All-time token total for a key, for display (not enforcement). Bounded only by the log retention window (`logRetentionDays`), same as every other usage query - no separate in-memory cap. */
export function sumAllTimeTokensForKey(apiKeyId: string): number {
  const row = readRuntimeDb()
    .query("SELECT COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) AS total FROM request_history WHERE api_key_id = ?")
    .get(apiKeyId) as { total: number };
  return row.total;
}

/** Removes one API key's running totals when the key is deleted. */
export function purgeKeyTokenAccumulator(apiKeyId: string): void {
  keyAccumulators.delete(apiKeyId);
}

/** Test-only: drop the cached per-key token accumulators so isolated test databases don't leak into each other. */
export function resetKeyTokenAccumulatorsForTests(): void {
  keyAccumulators.clear();
}
