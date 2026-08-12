import { Database } from "bun:sqlite";
import type { RequestRoutingMetadata, UsageDimension, UsagePeriod } from "../../application/contracts";
import { isWebSearchRouteKind } from "../../application/web-search-routing";
import { mapClientName, mapClientSource, orZero, periodStartUtc, utcDayBounds, utcMonthBounds, type ApiKeyUsageRow, type ChartBucket, type IpSummaryRow, type ModelTokenTotalsRow, type ProviderModelTotalsRow, type ProviderTodayRow, type RuntimeMetadataRepository, type RuntimeRequestFilters, type RuntimeRequestPage, type RuntimeRequestRow, type UsageByRow, type UsageCacheRow, type UsageCacheSummary, type UsageSummary } from "./runtime";

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
  meta_json: string | null;
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
  reasoning_tokens, total_tokens, usage_source, meta_json, client_name, client_source, message_count, tool_count, image_count, tfft_ms, client_ip`;

function parseRoutingMetadata(value: string | null): RequestRoutingMetadata {
  if (value === null) return { requestedModel: null, mappedModel: null, upstreamModel: null, wireSurface: null, errorMessage: null };
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) throw new Error("metadata is not an object");
    const record = parsed as Record<string, unknown>;
    const webSearchRoute = isWebSearchRouteKind(record.webSearchRoute) ? record.webSearchRoute : undefined;
    const webSearchFallbacks = Array.isArray(record.webSearchFallbacks)
      ? record.webSearchFallbacks.slice(0, 32).flatMap((entry): Array<{ readonly previousRouteId: string; readonly replacementRouteId: string | null; readonly reason: string }> => {
          if (typeof entry !== "object" || entry === null) return [];
          const value = entry as Record<string, unknown>;
          if (typeof value.previousRouteId !== "string" || typeof value.reason !== "string") return [];
          return [{ previousRouteId: value.previousRouteId, replacementRouteId: typeof value.replacementRouteId === "string" ? value.replacementRouteId : null, reason: value.reason }];
        })
      : [];
    return {
      requestedModel: typeof record.requestedModel === "string" ? record.requestedModel : null,
      mappedModel: typeof record.mappedModel === "string" ? record.mappedModel : null,
      upstreamModel: typeof record.upstreamModel === "string" ? record.upstreamModel : null,
      wireSurface: typeof record.wireSurface === "string" ? record.wireSurface : null,
      errorMessage: typeof record.errorMessage === "string" ? record.errorMessage : null,
      ...(webSearchRoute === undefined ? {} : { webSearchRoute, webSearchPassthrough: record.webSearchPassthrough === true || webSearchRoute === "passthrough" }),
      ...(webSearchFallbacks.length === 0 ? {} : { webSearchFallbacks }),
    };
  } catch {
    return { requestedModel: null, mappedModel: null, upstreamModel: null, wireSurface: null, errorMessage: null };
  }
}

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
    routing: parseRoutingMetadata(row.meta_json),
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

/** Full prompt size after normalized telemetry separates uncached/cache tokens. */
const FULL_PROMPT_INPUT_SQL = "COALESCE(input_tokens, 0) + COALESCE(cached_tokens, 0) + COALESCE(cache_write_tokens, 0)";

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


export function createRuntimeMetadataRepository(getDb: () => Database): RuntimeMetadataRepository {
  const cache = new BoundedTtlCache(2_000, 32);

  const invalidate = (): void => cache.clear();

  return {
    queryRequests(filters: RuntimeRequestFilters): RuntimeRequestPage {
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
      const row = getDb().query(`SELECT ${REQUEST_COLUMNS} FROM request_history WHERE id = ?`).get(id) as RequestHistoryRow | null;
      return row ? toRuntimeRow(row) : null;
    },
    querySummary(period: UsagePeriod): UsageSummary {
      return cache.get(`summary:${period}`, () => {
        const row = getDb()
          .query(
            `SELECT
              COUNT(*) AS requests,
              COALESCE(SUM(${FULL_PROMPT_INPUT_SQL}), 0) AS inputTokens,
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
        const rows = getDb()
          .query(
            `SELECT CASE
              WHEN model IS NOT NULL AND provider IS NOT NULL AND model LIKE provider || '/%' THEN model
              ELSE COALESCE(provider || '/' || model, COALESCE(model, provider, 'unknown'))
            END AS name,
            COUNT(*) AS requests,
            COALESCE(SUM(${FULL_PROMPT_INPUT_SQL}), 0) AS input_tokens,
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
        // Bucketing happens in SQLite (see chartBucketExpr) so the response is
        // bounded by the distinct bucket count, never by the window's row count;
        // only the most recent MAX_CHART_BUCKETS buckets are returned.
        const rows = getDb()
          .query(
            `SELECT ${chartBucketExpr(period)} AS t,
              COUNT(*) AS requests,
              COALESCE(SUM(${FULL_PROMPT_INPUT_SQL}), 0) AS input,
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
        const column = dimension === "model" ? "model" : dimension === "provider" ? "provider" : "api_key_prefix";
        const fallback = dimension === "key" ? "anonymous" : "unknown";
        return getDb()
          .query(
            `SELECT
              COALESCE(${column}, ?) AS name,
              COUNT(*) AS requests,
              COALESCE(SUM(${FULL_PROMPT_INPUT_SQL}), 0) AS input,
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
      // Aggregated entirely in SQLite; the cap bounds the response to the
      // top distinct provider × model combos by full prompt tokens.
      return getDb()
        .query(
          `SELECT provider, model, COALESCE(SUM(${FULL_PROMPT_INPUT_SQL}), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens
           FROM request_history
           WHERE started_at >= ?
           GROUP BY provider, model
           ORDER BY inputTokens DESC
           LIMIT ${MAX_PROVIDER_MODEL_TOTALS}`,
        )
        .all(periodStartUtc(period)) as ProviderModelTotalsRow[];
    },
    queryModelTokenTotals(period: UsagePeriod): ModelTokenTotalsRow[] {
      return getDb()
        .query(
          `SELECT model, provider, COALESCE(SUM(${FULL_PROMPT_INPUT_SQL}), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens
           FROM request_history
           WHERE started_at >= ? AND model IS NOT NULL
           GROUP BY model, provider
           ORDER BY inputTokens DESC
           LIMIT ${MAX_PROVIDER_MODEL_TOTALS}`,
        )
        .all(periodStartUtc(period)) as ModelTokenTotalsRow[];
    },
    queryProviderToday(): ProviderTodayRow[] {
      const bounds = utcDayBounds();
      return getDb()
        .query(
          `SELECT
            provider,
            COUNT(*) AS requests,
            COALESCE(SUM(${FULL_PROMPT_INPUT_SQL}), 0) AS input,
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
      const row = getDb().query("SELECT error_kind FROM request_history WHERE provider = ? AND status >= 400 ORDER BY id DESC LIMIT 1").get(provider) as { error_kind: string | null } | null;
      return row?.error_kind ?? null;
    },
    queryIpSummary(limit: number): IpSummaryRow[] {
      const cap = Math.max(1, Math.min(500, Math.floor(limit)));
      return getDb()
        .query(
          `SELECT
            client_ip AS ip,
            COUNT(*) AS requests,
            COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors,
            MAX(started_at) AS lastRequestAt,
            COALESCE(SUM(${FULL_PROMPT_INPUT_SQL}), 0) AS inputTokens,
            COALESCE(SUM(output_tokens), 0) AS outputTokens
          FROM request_history
          WHERE client_ip IS NOT NULL AND client_ip != ''
          GROUP BY client_ip
          ORDER BY lastRequestAt DESC
          LIMIT ?`,
        )
        .all(cap) as IpSummaryRow[];
    },
    sumKeyTokens(keyId: string): { readonly dailyUsed: number; readonly monthlyUsed: number; readonly allTimeUsed: number } {
      const day = utcDayBounds();
      const month = utcMonthBounds();
      const row = getDb().query("SELECT COALESCE(SUM(total_tokens), 0) AS allTimeUsed, COALESCE(SUM(CASE WHEN started_at >= ? AND started_at < ? THEN total_tokens ELSE 0 END), 0) AS dailyUsed, COALESCE(SUM(CASE WHEN started_at >= ? AND started_at < ? THEN total_tokens ELSE 0 END), 0) AS monthlyUsed FROM request_history WHERE api_key_id = ?").get(day.start, day.end, month.start, month.end, keyId) as { dailyUsed: number; monthlyUsed: number; allTimeUsed: number };
      return { dailyUsed: row.dailyUsed, monthlyUsed: row.monthlyUsed, allTimeUsed: row.allTimeUsed };
    },
    queryApiKeyUsage(): ApiKeyUsageRow[] {
      return getDb()
        .query(
          `SELECT api_key_id AS apiKeyId,
            COALESCE(SUM(total_tokens), 0) AS totalUsage,
            COUNT(*) AS totalRequests
           FROM request_history
           WHERE api_key_id IS NOT NULL AND api_key_id != ''
           GROUP BY api_key_id`,
        )
        .all() as ApiKeyUsageRow[];
    },
    invalidate,
  };
}
