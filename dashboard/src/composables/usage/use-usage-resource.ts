import { createQuery, type CreateQueryResult } from "@tanstack/solid-query";
import type { Accessor } from "solid-js";
import {
  consoleGet,
  normalizeTelemetryBuckets,
  type TelemetryBucket,
} from "../../lib/console-api";

interface UsageResourceOptions {
  enabled?: boolean;
  refetchInterval?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
interface UsageSummaryResource {
  period: string;
  totals: {
    requests: number | null;
    inputTokens: number | null;
    cachedTokens: number | null;
    outputTokens: number | null;
    errors: number | null;
    avgDurationMs: number | null;
    estimatedCostUsd: number | null;
    partial: boolean;
  };
}

interface UsageChartResource {
  buckets: Array<{
    t: string;
    requests: number;
    input: number | null;
    cached: number | null;
    output: number | null;
  }>;
}

export interface UsageBreakdownRow {
  name: string;
  requests: number | null;
  input: number | null;
  output: number | null;
  cached: number | null;
  total: number | null;
  errors: number | null;
  costUsd: number | null;
}

export interface ClientDistributionResource {
  total: number | null;
  unknown: number | null;
  items: Array<{
    family: string;
    label: string;
    count: number;
    percentage: number;
    tone: string;
    source: string | null;
    confidence: string | null;
  }>;
}

type TelemetryQueryOptions = {
  from?: string;
  to?: string;
  period?: string;
  bucket?: "minute" | "hour" | "day" | "auto";
  cursor?: string;
  limit?: number;
  groupBy?: "model" | "provider" | "client";
};
function boundedString(value: unknown, max = 120): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  ) {
    return null;
  }
  return value.slice(0, max);
}
function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : null;
}

export function serializeTelemetryQuery(
  options: TelemetryQueryOptions,
): string {
  const params = new URLSearchParams();
  const add = (key: string, value: string | number | undefined) => {
    if (value !== undefined && value !== "") params.set(key, String(value));
  };
  const period =
    options.period === "1h" ||
    options.period === "24h" ||
    options.period === "7d" ||
    options.period === "30d" ||
    options.period === "all"
      ? options.period
      : undefined;
  add("from", boundedString(options.from, 64) ?? undefined);
  add("to", boundedString(options.to, 64) ?? undefined);
  add("period", period);
  add("bucket", options.bucket);
  add("cursor", boundedString(options.cursor, 128) ?? undefined);
  if (options.limit !== undefined && Number.isFinite(options.limit))
    add("limit", Math.max(1, Math.min(1000, Math.trunc(options.limit))));
  add("group_by", options.groupBy);
  return params.toString();
}

function optionsFromPath(
  path: string,
  overrides: TelemetryQueryOptions = {},
): TelemetryQueryOptions {
  const query = new URLSearchParams(path.split("?", 2)[1] ?? "");
  const period = query.get("period") ?? "24h";
  return {
    period,
    bucket: period === "1h" ? "minute" : period === "all" ? "day" : "hour",
    ...overrides,
  };
}

function periodFromPath(path: string): string {
  return (
    new URLSearchParams(path.split("?", 2)[1] ?? "").get("period") ?? "24h"
  );
}

function toSummary(period: string, value: unknown): UsageSummaryResource {
  if (!isRecord(value))
    throw new Error("usage telemetry contract is unavailable");
  const requests = finiteOrNull(value.requests);
  const inputTokens = finiteOrNull(value.input_tokens);
  const outputTokens = finiteOrNull(value.output_tokens);
  const totalTokens = finiteOrNull(value.total_tokens);
  return {
    period,
    totals: {
      requests,
      inputTokens,
      cachedTokens: null,
      outputTokens,
      errors: null,
      avgDurationMs: null,
      estimatedCostUsd: null,
      partial:
        inputTokens === null || outputTokens === null || totalTokens === null,
    },
  };
}

function toChart(buckets: readonly TelemetryBucket[]): UsageChartResource {
  return {
    buckets: buckets.map((bucket) => ({
      t: bucket.timestamp,
      requests: bucket.count,
      input: null,
      cached: null,
      output: null,
    })),
  };
}

function toClientDistribution(value: unknown): ClientDistributionResource {
  if (!isRecord(value) || !Array.isArray(value.items))
    throw new Error("client distribution contract is unavailable");
  const total = finiteOrNull(value.total);
  const unknown = finiteOrNull(value.unknown);
  if (total === null || unknown === null)
    throw new Error("client distribution totals are unavailable");
  return {
    total,
    unknown,
    items: value.items.flatMap((item): ClientDistributionResource["items"] => {
      if (!isRecord(item)) return [];
      const family = boundedString(item.client, 32);
      const count = finiteOrNull(item.count);
      const percentage = finiteOrNull(item.percentage);
      if (family === null || count === null || percentage === null) return [];
      return [
        {
          family,
          label: family,
          count,
          percentage,
          tone: "var(--accent)",
          source: boundedString(item.source, 32),
          confidence: boundedString(item.confidence, 32),
        },
      ];
    }),
  };
}

function toRows(
  value: unknown,
  dimension: string,
): { rows: UsageBreakdownRow[] } {
  if (!isRecord(value))
    throw new Error("usage breakdown contract is unavailable");
  const map =
    dimension === "model"
      ? value.by_model
      : dimension === "provider"
        ? value.by_provider
        : null;
  if (!isRecord(map))
    throw new Error("usage breakdown is unavailable from daemon telemetry");
  return {
    rows: Object.entries(map).flatMap(([name, raw]): UsageBreakdownRow[] => {
      const total = finiteOrNull(raw);
      if (total === null) return [];
      return [
        {
          name: name.slice(0, 120),
          requests: null,
          input: null,
          output: null,
          cached: null,
          total,
          errors: null,
          costUsd: null,
        },
      ];
    }),
  };
}

async function fetchUsageResource<T>(path: string): Promise<T> {
  if (path.startsWith("/usage/summary")) {
    const query = serializeTelemetryQuery(optionsFromPath(path));
    return toSummary(
      periodFromPath(path),
      await consoleGet<unknown>(`/telemetry/usage?${query}`),
    ) as T;
  }
  if (path.startsWith("/usage/chart")) {
    const query = serializeTelemetryQuery(
      optionsFromPath(path, { limit: 200 }),
    );
    return toChart(
      normalizeTelemetryBuckets(
        await consoleGet<unknown>(`/telemetry/requests?${query}`),
      ),
    ) as T;
  }
  if (path.startsWith("/usage/clients")) {
    const query = serializeTelemetryQuery(
      optionsFromPath(path, { groupBy: "client" }),
    );
    return toClientDistribution(
      await consoleGet<unknown>(`/telemetry/clients?${query}`),
    ) as T;
  }
  if (path.startsWith("/usage/by-")) {
    const dimension = path.slice("/usage/by-".length).split("?", 1)[0];
    const groupBy =
      dimension === "model" || dimension === "provider" ? dimension : undefined;
    if (groupBy === undefined)
      throw new Error("usage breakdown is unavailable from daemon telemetry");
    const query = serializeTelemetryQuery(optionsFromPath(path, { groupBy }));
    return toRows(
      await consoleGet<unknown>(`/telemetry/usage?${query}`),
      dimension,
    ) as T;
  }
  if (path.startsWith("/usage/cache"))
    throw new Error("cache telemetry is unavailable from daemon telemetry");
  if (path.startsWith("/usage/requests"))
    throw new Error(
      "request evidence is available from Console Log, not Usage",
    );
  throw new Error("usage dimension is unavailable from daemon telemetry");
}

/** Centralizes authenticated usage reads while keeping each feature query typed. */
export function useUsageResource<T>(
  queryKey: readonly unknown[] | Accessor<readonly unknown[]>,
  path: string | Accessor<string>,
  options: UsageResourceOptions = {},
): CreateQueryResult<T, Error> {
  const readKey = () => typeof queryKey === "function" ? queryKey() : queryKey;
  const readPath = () => typeof path === "function" ? path() : path;
  return createQuery(() => ({
    queryKey: readKey(),
    queryFn: () => fetchUsageResource<T>(readPath()),
    enabled: options.enabled ?? true,
    refetchInterval: options.refetchInterval,
  }));
}
