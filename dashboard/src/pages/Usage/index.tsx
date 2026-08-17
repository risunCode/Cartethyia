import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  Database,
  DollarSign,
  Radio,
  TriangleAlert,
  Wrench,
} from "lucide-solid";
import { For, Show, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js";
import { Card, CardHeader } from "@components/ui/card";
import { StatePanel } from "@components/ui/state";
import { Button } from "@components/ui/button";
import { Tabs, Select } from "@components/ui/tabs";
import { MetricCard, MetricCardSkeleton } from "@components/shared/MetricCard";
import { consoleGet } from "@lib/console-api";
import { apiCache, getCacheKey } from "@lib/cache";
import { fetchProviderCatalog, type ProviderCatalogEntry } from "@lib/quota-contracts";
import {
  serializeTelemetryQuery,
  type UsageBreakdownRow,
} from "@/composables/usage/use-usage-resource";
import { formatNumber, formatTokens, formatUsd } from "@lib/format";

export type Period = "1h" | "24h" | "7d" | "30d" | "all";
export type Metric = "requests" | "tokens" | "cached";
export type Dimension = "model" | "provider" | "key";

export interface Summary {
  requests: number | null;
  inputTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
  errors: number | null;
  avgDurationMs: number | null;
  estimatedCostUsd: number | null;
  partial?: boolean;
}

export interface ChartBucket {
  t: string;
  requests: number;
  input: number | null;
  cached: number | null;
  output: number | null;
}

export interface TelemetryBundle {
  summary: Summary;
  buckets: ChartBucket[];
  clients: {
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
  };
  rows: UsageBreakdownRow[];
}

const USAGE_CACHE_TTL_MS = 30_000;
const USAGE_REFRESH_MS = 15_000;

function usageBucket(period: Period): "minute" | "hour" | "day" {
  return period === "1h" ? "minute" : period === "all" ? "day" : "hour";
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : null;
}

function sumErrorCounts(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null || !("items" in payload)) return null;
  const items = (payload as { items: unknown }).items;
  if (!Array.isArray(items)) return null;
  let total = 0;
  for (const entry of items) {
    if (typeof entry !== "object" || entry === null || !("count" in entry)) continue;
    const count = (entry as { count: unknown }).count;
    if (typeof count === "number" && Number.isFinite(count) && count > 0) {
      total += count;
    }
  }
  return total;
}

const STAT_CARDS = [
  { key: "requests", label: "Requests", note: "All routed requests", icon: Activity, tone: "info", format: formatNumber },
  { key: "inputTokens", label: "Input tokens", note: "Prompt tokens", icon: ArrowDownToLine, tone: "accent", format: formatTokens },
  { key: "cachedTokens", label: "Cached tokens", note: "Read from cache", icon: Database, tone: "info", format: formatTokens },
  { key: "outputTokens", label: "Output tokens", note: "Completion tokens", icon: ArrowUpFromLine, tone: "success", format: formatTokens },
  { key: "errors", label: "Errors", note: "Failed requests", icon: TriangleAlert, tone: "danger", format: formatNumber },
  { key: "estimatedCostUsd", label: "Est. cost", note: "Estimated, not billing", icon: DollarSign, tone: "warning", format: formatUsd },
] as const;

const PERIOD_OPTIONS = [
  { value: "1h", label: "1h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "all" },
] as const;

export default function Usage() {
  const [period, setPeriod] = createSignal<Period>(
    (typeof window !== "undefined"
      ? (new URLSearchParams(window.location.search).get("period") as Period)
      : null) ?? "24h",
  );
  const [metric, setMetric] = createSignal<Metric>("requests");
  const [dimension, setDimension] = createSignal<Dimension>("model");

  const [providerCatalog, setProviderCatalog] = createSignal<readonly ProviderCatalogEntry[]>([]);
  onMount(async () => {
    try {
      setProviderCatalog(await fetchProviderCatalog());
    } catch {
      // Fallback
    }
  });

  const providerNames = createMemo(() => {
    const map = new Map<string, string>();
    for (const p of providerCatalog()) {
      map.set(p.id.toLowerCase(), p.name);
    }
    return map;
  });

  const getDisplayName = (name: string, dim: Dimension): string => {
    if (dim === "provider") {
      return providerNames().get(name.toLowerCase()) ?? name;
    }
    return name;
  };

  const [data, { refetch }] = createResource(
    () => ({ period: period(), dimension: dimension() }),
    async ({ period, dimension }): Promise<TelemetryBundle> => {
      const cacheKey = getCacheKey("/telemetry/bundle", { period, dimension });
      const cached = apiCache.get<TelemetryBundle>(cacheKey);
      if (cached) return cached;

      const query = serializeTelemetryQuery({ period, bucket: usageBucket(period) });
      const seriesQuery = serializeTelemetryQuery({ period, bucket: usageBucket(period), limit: 200 });
      const clientsQuery = serializeTelemetryQuery({ period, groupBy: "client" });
      const breakdownQuery = serializeTelemetryQuery({
        period,
        groupBy: dimension === "model" || dimension === "provider" ? dimension : undefined,
      });

      const [usageRaw, requestsRaw, errorsRaw, clientsRaw, breakdownRaw] = await Promise.all([
        consoleGet<unknown>(`/telemetry/usage?${query}`).catch(() => ({})),
        consoleGet<unknown>(`/telemetry/requests?${seriesQuery}`).catch(() => ({ items: [] })),
        consoleGet<unknown>(`/telemetry/errors?${query}`).catch(() => null),
        consoleGet<unknown>(`/telemetry/clients?${clientsQuery}`).catch(() => ({ items: [], total: 0, unknown: 0 })),
        consoleGet<unknown>(`/telemetry/usage?${breakdownQuery}`).catch(() => ({})),
      ]);

      const requestsObj = typeof requestsRaw === "object" && requestsRaw !== null ? (requestsRaw as Record<string, unknown>) : {};
      const usageObj = typeof usageRaw === "object" && usageRaw !== null ? (usageRaw as Record<string, unknown>) : {};
      const clientsObj = typeof clientsRaw === "object" && clientsRaw !== null ? (clientsRaw as Record<string, unknown>) : {};
      const breakdownObj = typeof breakdownRaw === "object" && breakdownRaw !== null ? (breakdownRaw as Record<string, unknown>) : {};

      const reqBuckets: ChartBucket[] = Array.isArray(requestsObj["items"])
        ? (requestsObj["items"] as unknown[]).flatMap((b) => {
            if (typeof b !== "object" || b === null) return [];
            const item = b as Record<string, unknown>;
            const timestamp = typeof item["timestamp"] === "string" ? item["timestamp"] : typeof item["t"] === "string" ? item["t"] : "";
            const count = typeof item["count"] === "number" ? item["count"] : typeof item["requests"] === "number" ? item["requests"] : 0;
            return [{
              t: timestamp,
              requests: count,
              input: null,
              cached: null,
              output: null,
            }];
          })
        : [];

      const rawBy =
        dimension === "model"
          ? breakdownObj["by_model"]
          : dimension === "provider"
            ? breakdownObj["by_provider"]
            : breakdownObj["by_key"];

      const rows: UsageBreakdownRow[] = typeof rawBy === "object" && rawBy !== null && !Array.isArray(rawBy)
        ? Object.entries(rawBy as Record<string, unknown>).map(([name, total]) => ({
            name,
            requests: null,
            input: null,
            output: null,
            cached: null,
            total: typeof total === "number" ? total : null,
            errors: null,
            costUsd: null,
          }))
        : [];

      const summary: Summary = {
        requests: finiteOrNull(usageObj["requests"]),
        inputTokens: finiteOrNull(usageObj["input_tokens"]),
        cachedTokens: finiteOrNull(usageObj["cached_tokens"]),
        outputTokens: finiteOrNull(usageObj["output_tokens"]),
        errors: sumErrorCounts(errorsRaw),
        avgDurationMs: finiteOrNull(usageObj["avg_duration_ms"]),
        estimatedCostUsd: finiteOrNull(usageObj["estimated_cost_usd"]),
        partial: Boolean(usageObj["partial"]),
      };

      const result: TelemetryBundle = {
        summary,
        buckets: reqBuckets,
        clients: {
          total: finiteOrNull(clientsObj["total"]),
          unknown: finiteOrNull(clientsObj["unknown"]),
          items: Array.isArray(clientsObj["items"])
            ? (clientsObj["items"] as unknown[]).flatMap((item) => {
                if (typeof item !== "object" || item === null) return [];
                const rec = item as Record<string, unknown>;
                const family = typeof rec["client"] === "string" ? rec["client"] : typeof rec["family"] === "string" ? rec["family"] : "unknown";
                const label = typeof rec["label"] === "string" ? rec["label"] : family;
                const count = typeof rec["count"] === "number" ? rec["count"] : 0;
                const percentage = typeof rec["percentage"] === "number" ? rec["percentage"] : 0;
                return [{
                  family,
                  label,
                  count,
                  percentage,
                  tone: "var(--accent)",
                  source: typeof rec["source"] === "string" ? rec["source"] : null,
                  confidence: typeof rec["confidence"] === "string" ? rec["confidence"] : null,
                }];
              })
            : [],
        },
        rows,
      };

      apiCache.set(cacheKey, result, USAGE_CACHE_TTL_MS);
      return result;
    },
  );

  onMount(() => {
    const timer = setInterval(() => void refetch(), USAGE_REFRESH_MS);
    onCleanup(() => clearInterval(timer));
  });

  const summary = () => data()?.summary;
  const buckets = () => data()?.buckets ?? [];
  const rows = () => data()?.rows ?? [];

  const maxBucketRequests = createMemo(() => Math.max(1, ...buckets().map((b) => b.requests)));
  const linePoints = createMemo(() =>
    buckets().map((bucket, index) => {
      const x = buckets().length <= 1 ? 400 : (index / (buckets().length - 1)) * 760 + 20;
      const y = 210 - (bucket.requests / maxBucketRequests()) * 180;
      return { x, y, bucket };
    }),
  );
  const line = createMemo(() => linePoints().map((p) => `${p.x},${p.y}`).join(" "));
  const area = createMemo(() => {
    const pts = linePoints();
    if (pts.length === 0) return "";
    return `${pts[0].x},220 ${pts.map((p) => `${p.x},${p.y}`).join(" ")} ${pts[pts.length - 1].x},220`;
  });
  const tokenAvailable = (): boolean => buckets().some((b) => b.input != null);

  const snapshotRows = createMemo(() => rows().slice(0, 6));
  const maxSnapshotTotal = createMemo(() => {
    const totals = snapshotRows().flatMap((r) => (r.total === null ? [] : [r.total]));
    return totals.length > 0 ? Math.max(...totals) : 1;
  });

  return (
    <div class="dashboard-page animate-fade-in space-y-5">
      <header class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 class="text-xl font-bold text-[var(--text-1)]">Usage</h2>
          <p class="mt-1 text-xs text-[var(--text-2)]">Live telemetry from the API. Auto-refreshes every 15 seconds.</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Select
            ariaLabel="Usage time range"
            value={period()}
            onChange={(v) => setPeriod(v as Period)}
            options={PERIOD_OPTIONS}
          />
          <Button size="sm" variant="secondary" onClick={() => void refetch()}>
            Refresh
          </Button>
        </div>
      </header>

      {/* 6 Summary Stat Cards */}
      <section aria-label="Summary metrics">
        <Show
          when={!data.loading}
          fallback={
            <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <For each={STAT_CARDS}>{(card) => <MetricCardSkeleton label={card.label} />}</For>
            </div>
          }
        >
          <div class="grid grid-cols-2 gap-3 card-stagger lg:grid-cols-6">
            <For each={STAT_CARDS}>
              {(card) => (
                <MetricCard
                  label={card.label}
                  value={card.format(summary()?.[card.key] ?? null)}
                  icon={card.icon}
                  tone={card.tone}
                  description={card.note}
                />
              )}
            </For>
          </div>
        </Show>
      </section>

      {/* Traffic Chart & Breakdown Snapshot in 2 Columns */}
      <section class="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Traffic Chart Panel */}
        <Card density="compact">
          <CardHeader title="Traffic" icon={Radio} sub={`Requests per bucket · ${period()}`}>
            <div class="flex items-center gap-2">
              <Tabs
                tabs={[
                  { id: "requests", label: "Requests" },
                  { id: "tokens", label: "Tokens" },
                  { id: "cached", label: "Cached" },
                ]}
                value={metric()}
                onChange={(m) => setMetric(m as Metric)}
              />
            </div>
          </CardHeader>
          <Show
            when={metric() === "requests"}
            fallback={
              <Show
                when={metric() === "tokens"}
                fallback={
                  <StatePanel
                    kind="empty"
                    title="Cached evidence"
                    description="Cache hit telemetry is not available from the daemon. It will appear here once the telemetry contract is wired."
                    icon={Database}
                    density="compact"
                  />
                }
              >
                <Show
                  when={tokenAvailable()}
                  fallback={
                    <StatePanel
                      kind="empty"
                      title="Token evidence"
                      description="Token-level telemetry is not available from the daemon. It will appear here once the telemetry /usage contract provides it."
                      icon={ArrowUpFromLine}
                      density="compact"
                    />
                  }
                >
                  <StatePanel
                    kind="empty"
                    title="Token evidence pending"
                    description="Token-level telemetry has not been wired to the daemon endpoint yet."
                    icon={ArrowDownToLine}
                    density="compact"
                  />
                </Show>
              </Show>
            }
          >
            <Show
              when={!data.loading}
              fallback={<div class="h-56 animate-pulse rounded-xl bg-[var(--surface-muted)]" aria-label="Loading usage chart" />}
            >
              <Show
                when={buckets().length > 0}
                fallback={
                  <StatePanel
                    kind="empty"
                    title="No request telemetry"
                    description="No request data for this period."
                    icon={Activity}
                    density="compact"
                  />
                }
              >
                <div class="h-56 w-full" role="img" aria-label="Requests per bucket">
                  <svg viewBox="0 0 800 240" class="h-full w-full" preserveAspectRatio="none">
                    <defs>
                      <linearGradient id="usageChartFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.35" />
                        <stop offset="100%" stop-color="var(--accent)" stop-opacity="0.01" />
                      </linearGradient>
                    </defs>
                    <For each={[30, 75, 120, 165, 210]}>
                      {(y) => <line x1="20" x2="780" y1={y} y2={y} stroke="var(--inner-border)" stroke-dasharray="3 3" opacity="0.6" />}
                    </For>
                    <polygon points={area()} fill="url(#usageChartFill)" class="transition-opacity duration-300" />
                    <polyline
                      points={line()}
                      fill="none"
                      stroke="var(--accent)"
                      stroke-width="2.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      vector-effect="non-scaling-stroke"
                      class="transition-all duration-300"
                    />
                    <For each={linePoints()}>
                      {(point) => (
                        <circle
                          cx={point.x}
                          cy={point.y}
                          r="4"
                          fill="var(--surface-1)"
                          stroke="var(--accent)"
                          stroke-width="2"
                          class="cursor-pointer opacity-0 transition-opacity duration-150 hover:opacity-100"
                        >
                          <title>{`${point.bucket.t}: ${formatNumber(point.bucket.requests)} requests`}</title>
                        </circle>
                      )}
                    </For>
                  </svg>
                  <div class="flex justify-between px-2 text-[10px] text-[var(--text-3)]">
                    <span>{buckets()[0]?.t.slice(5, 16) ?? "—"}</span>
                    <span>{buckets()[buckets().length - 1]?.t.slice(5, 16) ?? "—"}</span>
                  </div>
                </div>
              </Show>
            </Show>
          </Show>
        </Card>

        {/* Breakdown Snapshot */}
        <Card density="compact">
          <CardHeader
            title="Breakdown"
            icon={Wrench}
            iconColor="#bf5af2"
            sub="Top items by total tokens"
          >
            <div class="flex items-center gap-1">
              <For each={[
                ["model", "Model"],
                ["provider", "Provider"],
                ["key", "Key"],
              ] as const}>
                {([id, label]) => (
                  <button
                    type="button"
                    onClick={() => setDimension(id)}
                    class={`rounded-full px-3 py-1 text-[10px] font-semibold transition-colors ${
                      dimension() === id
                        ? "bg-[var(--accent)] text-white"
                        : "bg-[var(--hover)] text-[var(--text-2)] hover:bg-[var(--surface-muted)]"
                    }`}
                  >
                    {label}
                  </button>
                )}
              </For>
            </div>
          </CardHeader>
          <div class="space-y-2 px-1">
            <Show
              when={!data.loading}
              fallback={
                <div class="space-y-2">
                  <div class="h-10 animate-pulse rounded-xl bg-[var(--surface-muted)]" />
                  <div class="h-10 animate-pulse rounded-xl bg-[var(--surface-muted)]" />
                </div>
              }
            >
              <Show
                when={snapshotRows().length > 0}
                fallback={
                  <StatePanel
                    kind="empty"
                    title="No usage for this period"
                    description="No breakdown data for the selected period."
                    icon={Activity}
                    density="compact"
                  />
                }
              >
                <For each={snapshotRows()}>
                  {(row) => {
                    const pct = () =>
                      row.total !== null && maxSnapshotTotal() > 0 ? Math.max(2, (row.total / maxSnapshotTotal()) * 100) : 2;
                    const displayName = () => getDisplayName(row.name, dimension());
                    return (
                      <div class="group relative overflow-hidden rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] transition-colors duration-150 hover:border-[var(--border-strong)]">
                        <div class="absolute inset-y-0 left-0 z-0 transition-all duration-300" style={{ width: `${pct()}%` }}>
                          <div class="h-full w-full bg-gradient-to-r from-[var(--accent)]/20 via-[var(--accent)]/15 to-transparent" />
                        </div>
                        <div class="relative z-[1] flex items-center justify-between gap-2 px-3 py-2.5">
                          <span class="min-w-0 flex-1 truncate font-mono text-[11px] font-semibold">
                            {displayName()}
                          </span>
                          <span class="shrink-0 text-right text-[11px] font-semibold tabular-nums text-[var(--accent)]">
                            {formatTokens(row.total)}
                          </span>
                        </div>
                      </div>
                    );
                  }}
                </For>
              </Show>
            </Show>
          </div>
        </Card>
      </section>


    </div>
  );
}
