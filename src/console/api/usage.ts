/** Usage API — summary, chart, by-*, recent, request list + detail. */

import { Elysia } from "elysia";
import { consoleError } from "../errors";
import {
  queryUsageSummary,
  queryUsageCost,
  queryUsageChart,
  queryUsageBy,
  queryUsageRequests,
  getUsageRequestById,
  getRequestTraceEvent,
  type UsagePeriod,
  type ChartMetric,
  type UsageDimension,
} from "../db/repos/usage";
import { getRequestDetailBundle, getStoredRequestPayload, purgeAllStoredData } from "../db/repos/details";
import { addAuditEvent } from "../db/repos/audit";
import { getInFlightCount } from "../tracking/in-flight";

const PERIODS: UsagePeriod[] = ["1h", "24h", "7d", "30d"];
const METRICS: ChartMetric[] = ["requests", "tokens", "cached"];

function parsePeriod(raw: string | undefined): UsagePeriod | null {
  return PERIODS.includes(raw as UsagePeriod) ? (raw as UsagePeriod) : null;
}

function badPeriod(set: { status?: number | string }) {
  set.status = 400;
  return consoleError("invalid_request", "period must be one of 1h, 24h, 7d, 30d");
}

export const usageRoutes = new Elysia({ prefix: "/console/api" })
  .get("/usage/summary", async ({ query, set }) => {
    const period = parsePeriod(query.period);
    if (!period) return badPeriod(set);
    const summary = queryUsageSummary(period);
    return {
      ...summary,
      ...queryUsageCost(period),
      inFlight: getInFlightCount(),
    };
  })
  .get("/usage/chart", async ({ query, set }) => {
    const period = parsePeriod(query.period);
    if (!period) return badPeriod(set);
    const metric = (query.metric ?? "requests") as ChartMetric;
    if (!METRICS.includes(metric)) {
      set.status = 400;
      return consoleError("invalid_request", "metric must be requests, tokens, or cached");
    }
    return { metric, period, buckets: queryUsageChart(period) };
  })
  .get("/usage/by-model", async ({ query, set }) => {
    const period = parsePeriod(query.period);
    if (!period) return badPeriod(set);
    return { rows: queryUsageBy("model" satisfies UsageDimension, period) };
  })
  .get("/usage/by-provider", async ({ query, set }) => {
    const period = parsePeriod(query.period);
    if (!period) return badPeriod(set);
    return { rows: queryUsageBy("provider", period) };
  })
  .get("/usage/by-key", async ({ query, set }) => {
    const period = parsePeriod(query.period);
    if (!period) return badPeriod(set);
    return { rows: queryUsageBy("key", period) };
  })
  .get("/usage/recent", async () => {
    return queryUsageRequests({ limit: 10 });
  })
  .get("/usage/requests", async ({ query, set }) => {
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
    const status = query.status !== undefined && query.status !== "" ? Number(query.status) : undefined;
    if (status !== undefined && !Number.isFinite(status)) {
      set.status = 400;
      return consoleError("invalid_request", "status must be a number");
    }
    return queryUsageRequests({
      cursor: query.cursor ? Number(query.cursor) : undefined,
      limit,
      provider: query.provider || undefined,
      model: query.model || undefined,
      key: query.key || undefined,
      status,
      stream: query.stream === "true" ? true : query.stream === "false" ? false : undefined,
      q: query.q || undefined,
    });
  })
  .post("/usage/purge-stored", () => {
    const result = purgeAllStoredData();
    addAuditEvent("usage.purge_stored", result as unknown as Record<string, unknown>);
    return { ok: true, ...result };
  })
  .get("/usage/requests/:id", async ({ params, set }) => {
    const id = Number(params.id);
    if (!Number.isInteger(id) || id <= 0) {
      set.status = 400;
      return consoleError("invalid_request", "id must be a positive integer");
    }
    const row = getUsageRequestById(id);
    if (!row) {
      set.status = 404;
      return consoleError("not_found", "request not found");
    }
    const bundle = getRequestDetailBundle(id);
    const traceEvent = getRequestTraceEvent(String(row.trace_id));
    // Details survive restarts by resolving the payload file only after its JSONL trace matches.
    const storedPayload = traceEvent ? getStoredRequestPayload(String(row.trace_id)) : null;
    const detail = storedPayload
      ? {
        ...(bundle.detail ?? {}),
        redacted_request: storedPayload.request,
        redacted_response: storedPayload.response,
        payload_path: storedPayload.path,
      }
      : bundle.detail;
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(String(row.meta_json ?? "{}")) as Record<string, unknown>;
    } catch {
      // keep empty
    }
    return {
      id: row.id,
      traceId: row.trace_id,
      endpoint: row.endpoint,
      surface: row.surface,
      provider: row.provider,
      model: row.model,
      apiKeyPrefix: row.api_key_prefix,
      status: row.status,
      errorKind: row.error_kind,
      stream: row.stream === 1,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      durationMs: row.duration_ms,
      usage: {
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cachedTokens: row.cached_tokens,
        cacheWriteTokens: row.cache_write_tokens,
        reasoningTokens: row.reasoning_tokens,
        totalTokens: row.total_tokens,
        source: row.usage_source,
      },
      meta,
      detail,
      trace: traceEvent ? {
        traceId: traceEvent.traceId,
        startedAt: traceEvent.startedAt,
        finishedAt: traceEvent.finishedAt,
        status: traceEvent.status,
        durationMs: traceEvent.durationMs,
        payload: (traceEvent.tracking as Record<string, unknown> | undefined)?.payload ?? null,
      } : null,
      toolCalls: bundle.toolCalls,
      assets: bundle.assets.map((a) => ({ ...a, storage_path: undefined })),
    };
  });
