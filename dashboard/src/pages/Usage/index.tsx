
import { Activity, ArrowDownToLine, ArrowUpFromLine, Database, TriangleAlert } from "lucide-solid";
import { For, Show, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js";
import { Card, CardHeader } from "@components/ui/card";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { StatePanel } from "@components/ui/state";
import { MetricCard, MetricCardSkeleton } from "@components/shared/MetricCard";
import { SSEInFlightTable } from "@components/shared/InFlightTable";
import { TimeRangePicker, type TimeRange } from "@components/forms/TimeRangePicker";
import { consoleFailure, consoleGet, consoleStreamUrl, normalizeTelemetryBuckets } from "@lib/console-api";
import { apiCache, getCacheKey } from "@lib/cache";
import { serializeTelemetryQuery } from "../../composables/usage/use-usage-resource";
import { formatNumber, formatTokens } from "@lib/format";
import { cn } from "@lib/cn";

export interface UsageSummary {
  requests: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  errors: number | null;
  period: TimeRange;
}

export interface UsageChartBucket {
  t: string;
  requests: number;
  input: number | null;
  cached: number | null;
  output: number | null;
}

export interface UsageChartResponse {
  buckets: readonly UsageChartBucket[];
  period: TimeRange;
}

export interface UsageResponse {
  summary: UsageSummary;
  chart: UsageChartResponse;
}

const USAGE_CACHE_TTL_MS = 30_000;
const USAGE_REFRESH_MS = 30_000;

function usageBucket(period: TimeRange): "minute" | "hour" | "day" {
  return period === "1h" ? "minute" : period === "all" ? "day" : "hour";
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : null;
}

/**
 * Sums error counts across `/telemetry/errors` buckets for the period. A
 * failed or malformed read degrades to null instead of failing the page.
 */
function sumErrorCounts(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null) return null;
  const items = (payload as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  let total = 0;
  for (const entry of items) {
    if (typeof entry !== "object" || entry === null) continue;
    const count = (entry as { count?: unknown }).count;
    if (typeof count === "number" && Number.isFinite(count) && count > 0) {
      total += count;
    }
  }
  return total;
}

/**
 * Reads period totals from `/telemetry/usage`, the request-volume series
 * from `/telemetry/requests`, and the error total from `/telemetry/errors`,
 * combining them into the page's summary + chart shape. Cached for 30s per
 * period.
 */
async function fetchUsage(period: TimeRange): Promise<UsageResponse> {
  const cacheKey = getCacheKey("/telemetry/usage", { period });
  const cached = apiCache.get<UsageResponse>(cacheKey);
  if (cached !== null) return cached;

  const query = serializeTelemetryQuery({ period, bucket: usageBucket(period) });
  const seriesQuery = serializeTelemetryQuery({ period, bucket: usageBucket(period), limit: 200 });
  const [usage, requests, errors] = await Promise.all([
    consoleGet<unknown>(`/telemetry/usage?${query}`),
    consoleGet<unknown>(`/telemetry/requests?${seriesQuery}`),
    consoleGet<unknown>(`/telemetry/errors?${query}`).catch(() => null),
  ]);

  const record = (typeof usage === "object" && usage !== null ? usage : {}) as Record<string, unknown>;
  const response: UsageResponse = {
    summary: {
      requests: finiteOrNull(record.requests),
      inputTokens: finiteOrNull(record.input_tokens),
      outputTokens: finiteOrNull(record.output_tokens),
      errors: sumErrorCounts(errors),
      period,
    },
    chart: {
      period,
      buckets: normalizeTelemetryBuckets(requests).map((bucket) => ({
        t: bucket.timestamp,
        requests: bucket.count,
        input: null,
        cached: null,
        output: null,
      })),
    },
  };
  apiCache.set(cacheKey, response, USAGE_CACHE_TTL_MS);
  return response;
}

const STAT_CARDS = [
  { key: "requests", label: "Requests", icon: Activity, color: "#0a84ff", format: formatNumber, tone: "accent" as const },
  { key: "inputTokens", label: "Input tokens", icon: ArrowDownToLine, color: "#64d2ff", format: formatTokens, tone: "info" as const },
  { key: "outputTokens", label: "Output", icon: ArrowUpFromLine, color: "#30d158", format: formatTokens, tone: "success" as const },
  { key: "errors", label: "Errors", icon: TriangleAlert, color: "#ff453a", format: formatNumber, tone: "danger" as const },
];

function UsageChart(props: { buckets: readonly UsageChartBucket[]; loading: boolean }) {
  const max = createMemo(() => Math.max(1, ...props.buckets.map((bucket) => bucket.requests)));

  const linePoints = createMemo(() =>
    props.buckets.map((bucket, index) => {
      const x = props.buckets.length <= 1 ? 400 : (index / (props.buckets.length - 1)) * 760 + 20;
      const y = 210 - (bucket.requests / max()) * 180;
      return { x, y, bucket };
    }),
  );

  const line = createMemo(() => linePoints().map((point) => `${point.x},${point.y}`).join(" "));

  const area = createMemo(() => {
    const current = linePoints();
    if (current.length === 0) return "";
    return `${current[0].x},220 ${current.map((point) => `${point.x},${point.y}`).join(" ")} ${current[current.length - 1].x},220`;
  });

  return (
    <Show
      when={!props.loading}
      fallback={<div class="h-56 animate-pulse rounded-xl bg-[var(--surface-muted)]" aria-label="Loading usage chart" />}
    >
      <Show
        when={props.buckets.length > 0}
        fallback={<StatePanel kind="empty" title="No request telemetry" description="There is no request telemetry for this period." density="compact" />}
      >
        <div class="h-56 w-full" role="img" aria-label="Requests per bucket">
          <svg viewBox="0 0 800 240" class="h-full w-full" preserveAspectRatio="none">
            <defs>
              <linearGradient id="usageChartFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.45" />
                <stop offset="100%" stop-color="var(--accent)" stop-opacity="0.02" />
              </linearGradient>
            </defs>
            <For each={[30, 75, 120, 165, 210]}>{(y) => <line x1="20" x2="780" y1={y} y2={y} stroke="var(--inner-border)" stroke-dasharray="3 3" />}</For>
            <polygon points={area()} fill="url(#usageChartFill)" />
            <polyline points={line()} fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke" />
            <For each={linePoints()}>
              {(point) => (
                <circle cx={point.x} cy={point.y} r="3" fill="var(--accent)" class="opacity-0 transition-opacity hover:opacity-100">
                  <title>{`${point.bucket.t}: ${formatNumber(point.bucket.requests)} requests`}</title>
                </circle>
              )}
            </For>
          </svg>
          <div class="flex justify-between px-2 text-[10px] text-[var(--text-3)]">
            <span>{props.buckets[0]?.t.slice(5, 16) ?? "—"}</span>
            <span>{props.buckets[props.buckets.length - 1]?.t.slice(5, 16) ?? "—"}</span>
          </div>
        </div>
      </Show>
    </Show>
  );
}

function asTimeRange(value: string | undefined): TimeRange {
  return value === "1h" || value === "7d" || value === "30d" || value === "all" ? value : "24h";
}

export default function Usage() {
  const [period, setPeriod] = createSignal<TimeRange>(asTimeRange(typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("period") ?? undefined : undefined));
  const [resource, { refetch }] = createResource(period, fetchUsage);

  // Spec requirement 2: usage data refreshes on an interval without a page reload.
  onMount(() => {
    const timer = setInterval(() => void refetch(), USAGE_REFRESH_MS);
    onCleanup(() => clearInterval(timer));
  });

  const isLoading = () => resource.loading;
  const isError = () => resource.error !== undefined;
  const errorInfo = createMemo(() => (resource.error ? consoleFailure(resource.error) : null));
  const summary = createMemo<UsageSummary | null>(() => (resource.error ? null : resource()?.summary ?? null));
  const buckets = createMemo<readonly UsageChartBucket[]>(() => (resource.error ? [] : resource()?.chart.buckets ?? []));

  return (
    <div class="dashboard-page animate-fade-in space-y-5">
      <header class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 class="text-xl font-bold text-[var(--text-1)]">Usage</h2>
          <p class="mt-1 text-xs text-[var(--text-2)]">Live telemetry from the API. Auto-refreshes every 30 seconds.</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <TimeRangePicker value={period()} onChange={setPeriod} ariaLabel="Usage time range" />
          <Button size="sm" variant="secondary" onClick={() => void refetch()}>
            Refresh
          </Button>
        </div>
      </header>

      <section aria-label="Summary metrics">
        <Show
          when={!isLoading()}
          fallback={
            <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
              <For each={STAT_CARDS}>{(card) => <MetricCardSkeleton label={card.label} />}</For>
            </div>
          }
        >
          <Show
            when={!isError()}
            fallback={
              <StatePanel
                kind={errorInfo()?.degraded ? "degraded" : "error"}
                title={errorInfo()?.degraded ? "Usage telemetry degraded" : "Failed to load usage"}
                description={errorInfo()?.message ?? "Unknown error"}
                action={
                  <Button variant="secondary" onClick={() => void refetch()}>
                    Retry
                  </Button>
                }
              />
            }
          >
            <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
              <For each={STAT_CARDS}>
                {(card) => (
                  <MetricCard
                    label={card.label}
                    value={card.format(summary()?.[card.key as keyof UsageSummary] as number | null)}
                    icon={card.icon}
                    tone={card.tone}
                    description={card.label}
                  />
                )}
              </For>
            </div>
          </Show>
        </Show>
      </section>

      <section class="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card density="compact" className="animate-fade-in lg:col-span-2">
          <CardHeader title="Request volume" icon={Activity} iconColor="#0a84ff" sub={`Buckets for ${period()}`}>
            <Badge tone="info" className="font-mono">{buckets().length} pts</Badge>
          </CardHeader>
          <UsageChart buckets={buckets()} loading={isLoading()} />
        </Card>

        <SSEInFlightTable
          streamUrl={consoleStreamUrl("/telemetry/in-flight/stream")}
          maxHeight="260px"
          emptyMessage="Waiting for first in-flight event…"
          className="lg:col-span-1"
        />
      </section>

      <section class="animate-fade-in">
        <Card density="compact">
          <CardHeader title="Period totals" icon={Database} iconColor="#bf5af2" sub={`Snapshot for ${period()}`} />
          <Show when={summary()} fallback={<p class="text-xs text-[var(--text-3)]">No telemetry available.</p>}>
            {(data) => (
              <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <div class={cn("rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-3")}>
                  <div class="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Requests</div>
                  <div class="mt-1 text-lg font-bold tabular-nums">{formatNumber(data().requests)}</div>
                </div>
                <div class="rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-3">
                  <div class="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Input</div>
                  <div class="mt-1 text-lg font-bold tabular-nums">{formatTokens(data().inputTokens)}</div>
                </div>
                <div class="rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-3">
                  <div class="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Output</div>
                  <div class="mt-1 text-lg font-bold tabular-nums">{formatTokens(data().outputTokens)}</div>
                </div>
                <div class="rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-3">
                  <div class="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Errors</div>
                  <div class="mt-1 text-lg font-bold tabular-nums">{formatNumber(data().errors)}</div>
                </div>
              </div>
            )}
          </Show>
        </Card>
      </section>
    </div>
  );
}
