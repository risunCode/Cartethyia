import { useQuery } from "@tanstack/react-query";
import { daemonFailure, daemonGet } from "../../lib/daemon-api";
import type { ClientDistributionItem } from "./client-distribution";
import { serializeTelemetryQuery } from "../../composables/usage/use-usage-resource";

export type UsagePeriod = "1h" | "24h" | "7d" | "30d" | "all";
export type UsageMetric = "requests" | "tokens" | "cached";

export interface UsageTotals {
  readonly requests: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

export interface UsageSummary {
  readonly requests: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly byProvider: Readonly<Record<string, number>>;
  readonly byModel: Readonly<Record<string, number>>;
}

export interface UsageBucket {
  readonly timestamp: string;
  readonly count: number;
  readonly errors: number | null;
  readonly latencyMs: number | null;
}

export interface ClientDistributionData {
  readonly total: number;
  readonly unknown: number;
  readonly items: readonly ClientDistributionItem[];
}

interface UsageState<T> {
  readonly data: T | undefined;
  readonly state: "loading" | "ready" | "degraded" | "unavailable";
  readonly errorMessage: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boundedString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 120) : null;
}

function parseNumberMap(value: unknown): Readonly<Record<string, number>> {
  if (!isRecord(value)) return {};
  const result: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    const parsed = numberOrNull(item);
    if (parsed !== null && key.length <= 120) result[key] = parsed;
  }
  return result;
}

function parseUsage(value: unknown): UsageSummary {
  if (!isRecord(value)) throw new Error("usage telemetry contract is unavailable");
  return {
    requests: numberOrNull(value.requests),
    inputTokens: numberOrNull(value.input_tokens),
    outputTokens: numberOrNull(value.output_tokens),
    totalTokens: numberOrNull(value.total_tokens),
    byProvider: parseNumberMap(value.by_provider),
    byModel: parseNumberMap(value.by_model),
  };
}

function parseBuckets(value: unknown): UsageBucket[] {
  if (!isRecord(value) || !Array.isArray(value.items)) throw new Error("request telemetry contract is unavailable");
  return value.items.flatMap((item): UsageBucket[] => {
    if (!isRecord(item)) return [];
    const timestamp = boundedString(item.timestamp);
    const count = numberOrNull(item.count);
    if (timestamp === null || count === null) return [];
    return [{ timestamp, count, errors: numberOrNull(item.errors), latencyMs: numberOrNull(item.latencyMs) }];
  }).slice(0, 200);
}

const CLIENT_TONES = ["var(--accent)", "var(--teal)", "var(--green)", "var(--orange)", "var(--purple)"] as const;

function parseClients(value: unknown): ClientDistributionData {
  if (!isRecord(value) || !Array.isArray(value.items)) throw new Error("client telemetry contract is unavailable");
  const items = value.items.flatMap((item, index): ClientDistributionItem[] => {
    if (!isRecord(item)) return [];
    const family = boundedString(item.client);
    const count = numberOrNull(item.count);
    const percentage = numberOrNull(item.percentage);
    if (family === null || count === null || percentage === null) return [];
    return [{ family, label: family, count, percentage, tone: CLIENT_TONES[index % CLIENT_TONES.length] }];
  });
  const total = numberOrNull(value.total);
  const unknown = numberOrNull(value.unknown);
  if (total === null || unknown === null) throw new Error("client telemetry totals are unavailable");
  return { total, unknown, items };
}

function queryState<T>(query: { data?: T; isLoading: boolean; error: unknown }): UsageState<T> {
  if (query.isLoading) return { data: undefined, state: "loading", errorMessage: null };
  if (query.error !== null) {
    const failure = daemonFailure(query.error);
    return {
      data: undefined,
      state: failure.code === "not_found" || failure.code === "unavailable" ? "unavailable" : "degraded",
      errorMessage: failure.message,
    };
  }
  return { data: query.data, state: "ready", errorMessage: null };
}

function useUsageQuery<T>(
  key: readonly unknown[],
  route: string,
  parser: (value: unknown) => T,
) {
  return useQuery({
    queryKey: key,
    queryFn: async () => parser(await daemonGet<unknown>(route)),
    refetchInterval: 10_000,
  });
}

export function useUsageObservability(period: UsagePeriod, metric: UsageMetric) {
  const query = serializeTelemetryQuery({ period, bucket: "hour" });
  const summaryQuery = useUsageQuery(
    ["v2", "telemetry", "usage", period],
    `/telemetry/usage?${query}`,
    parseUsage,
  );
  const bucketsQuery = useUsageQuery(
    ["v2", "telemetry", "requests", period],
    `/telemetry/requests?${serializeTelemetryQuery({ period, bucket: "hour", limit: 200 })}`,
    parseBuckets,
  );
  const clientsQuery = useUsageQuery(
    ["v2", "telemetry", "clients", period],
    `/telemetry/clients?${serializeTelemetryQuery({ period, bucket: "hour", groupBy: "client" })}`,
    parseClients,
  );
  return {
    summary: queryState(summaryQuery),
    buckets: queryState(bucketsQuery),
    clients: queryState(clientsQuery),
    metric,
  };
}
