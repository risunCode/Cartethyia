
import { Activity, AlertTriangle, Database, Server, Zap } from "lucide-solid";
import { For, Show, createMemo, createResource, onCleanup, onMount, type JSX } from "solid-js";
import { Card, CardHeader } from "@components/ui/card";
import { Badge } from "@components/ui/badge";
import { StatePanel } from "@components/ui/state";
import { Button } from "@components/ui/button";
import { ErrorList, type ErrorListItem } from "@components/shared/ErrorList";
import { MetricCard, MetricCardSkeleton } from "@components/shared/MetricCard";
import { consoleFailure, consoleGet } from "@lib/console-api";
import { apiCache, getCacheKey } from "@lib/cache";
import { formatNumber } from "@lib/format";

export interface DashboardSummary {
  requests: number | null;
  errors: number | null;
  uptime: string | null;
  memoryMb: number | null;
  activeProviders: number | null;
  recentErrors: readonly ErrorListItem[];
  fetchedAt: string;
  /** Endpoints whose failure degraded this summary (empty when all succeed). */
  failures: readonly SummaryEndpointFailure[];
}

/** Bounded failure info for one summary endpoint (already through consoleFailure). */
export interface SummaryEndpointFailure {
  label: string;
  code: string;
  message: string;
  degraded: boolean;
}

interface OverviewMetric {
  key: keyof DashboardSummary | "latencyMs";
  label: string;
  value: number | string | null;
  unit?: string;
  tone: "accent" | "info" | "success" | "warning" | "danger" | "neutral";
  description: string;
}

const METRIC_ICONS = {
  requests: Activity,
  latencyMs: Zap,
  errors: AlertTriangle,
  memoryMb: Database,
} as const;

const SUMMARY_CACHE_TTL_MS = 5_000;
const SUMMARY_REFRESH_MS = 5_000;
const SUMMARY_CACHE_ENDPOINT = "/dashboard";

const SUMMARY_ENDPOINTS = [
  { route: "/dashboard", label: "dashboard summary" },
  { route: "/telemetry/overview?period=24h", label: "telemetry overview" },
  { route: "/telemetry/errors?period=24h&limit=10", label: "recent errors" },
] as const;

const EMPTY_SUMMARY: DashboardSummary = {
  requests: null,
  errors: null,
  uptime: null,
  memoryMb: null,
  activeProviders: null,
  recentErrors: [],
  fetchedAt: "",
  failures: [],
};

function safeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Coerces error buckets from `/telemetry/errors` into bounded
 * ErrorList rows; malformed entries are dropped rather than rendered.
 */
function coerceErrorBuckets(value: unknown): ErrorListItem[] {
  const payload = safeRecord(value);
  const items = Array.isArray(payload.items) ? payload.items : [];
  const errors: ErrorListItem[] = [];
  for (let index = 0; index < items.length && errors.length < 10; index += 1) {
    const entry = safeRecord(items[index]);
    const metadata = safeRecord(entry.metadata);
    const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : new Date().toISOString();
    errors.push({
      id: `${timestamp}-${index}`,
      code: typeof metadata.code === "string" ? metadata.code.slice(0, 64) : "upstream_error",
      message:
        typeof metadata.message === "string" && metadata.message.trim().length > 0
          ? metadata.message.slice(0, 200)
          : "Request failed upstream",
      source: typeof metadata.provider === "string" ? metadata.provider.slice(0, 64) : "api",
      timestamp,
      count: safeNumber(entry.count) ?? 1,
      severity: metadata.severity === "warning" || metadata.severity === "info" ? metadata.severity : "error",
    });
  }
  return errors;
}

function coerceSummary(dashboard: unknown, overview: unknown, errorBuckets: unknown): Omit<DashboardSummary, "failures"> {
  const board = safeRecord(dashboard);
  const health = safeRecord(board.health);
  const telemetry = safeRecord(overview);
  return {
    requests: safeNumber(telemetry.requests),
    errors: safeNumber(telemetry.errors),
    uptime: typeof board.uptime === "string" && board.uptime.length > 0 ? board.uptime : null,
    memoryMb: safeNumber(health.memoryMb),
    activeProviders: safeNumber(board.accountCount),
    recentErrors: coerceErrorBuckets(errorBuckets),
    fetchedAt: new Date().toISOString(),
  };
}

interface SummaryEndpointResult {
  value: unknown;
  failure: SummaryEndpointFailure | null;
}

async function fetchSummaryEndpoint(endpoint: (typeof SUMMARY_ENDPOINTS)[number]): Promise<SummaryEndpointResult> {
  try {
    return { value: await consoleGet<unknown>(endpoint.route), failure: null };
  } catch (error) {
    const failure = consoleFailure(error) ?? { code: "network_error", message: "API request failed", degraded: false };
    return { value: null, failure: { label: endpoint.label, ...failure } };
  }
}

/**
 * Combines the API summary (`/dashboard`), 24h request/error
 * totals (`/telemetry/overview`), and recent error buckets
 * (`/telemetry/errors`) into one Overview payload. Each endpoint settles
 * independently: a failure degrades only the metrics it feeds (recorded in
 * `failures` so the page can surface it) instead of failing the whole view.
 */
async function fetchSummary(): Promise<DashboardSummary> {
  const cacheKey = getCacheKey(SUMMARY_CACHE_ENDPOINT, { period: "24h" });
  const cached = apiCache.get<DashboardSummary>(cacheKey);
  if (cached !== null) return cached;

  const [dashboard, overview, errors] = await Promise.all(SUMMARY_ENDPOINTS.map(fetchSummaryEndpoint));
  const summary: DashboardSummary = {
    ...coerceSummary(dashboard.value, overview.value, errors.value),
    failures: [dashboard, overview, errors].flatMap((result) => (result.failure ? [result.failure] : [])),
  };
  apiCache.set(cacheKey, summary, SUMMARY_CACHE_TTL_MS);
  return summary;
}

function deriveMetrics(summary: DashboardSummary): OverviewMetric[] {
  const errorRate = summary.requests && summary.requests > 0 ? ((summary.errors ?? 0) / summary.requests) * 100 : null;
  return [
    {
      key: "requests",
      label: "Requests",
      value: summary.requests,
      tone: "accent",
      description: "Last 24h routed traffic",
    },
    {
      key: "latencyMs",
      label: "Error rate",
      value: errorRate === null ? null : `${errorRate.toFixed(1)}%`,
      tone: errorRate === null ? "neutral" : errorRate > 5 ? "danger" : "success",
      description: summary.errors === null ? "No errors reported" : `${formatNumber(summary.errors)} failed requests`,
    },
    {
      key: "memoryMb",
      label: "Memory",
      value: summary.memoryMb,
      unit: "MB",
      tone: "info",
      description: "Resident memory (RSS)",
    },
    {
      key: "activeProviders",
      label: "Providers",
      value: summary.activeProviders,
      tone: "success",
      description: "Active provider accounts",
    },
  ];
}

function renderMetricValue(metric: OverviewMetric): JSX.Element {
  if (metric.value === null || metric.value === undefined) {
    return <span class="text-[var(--text-3)]">—</span>;
  }
  if (typeof metric.value === "number") {
    return (
      <span class="tabular-nums">
        {formatNumber(metric.value)}
        {metric.unit && <span class="ml-1 text-xs font-normal text-[var(--text-3)]">{metric.unit}</span>}
      </span>
    );
  }
  return <span class="tabular-nums">{metric.value}</span>;
}

export default function Overview() {
  const [resource, { refetch }] = createResource(fetchSummary);

  // Spec requirement 1: metric data refreshes every 5s without a page reload.
  onMount(() => {
    const timer = setInterval(() => void refetch(), SUMMARY_REFRESH_MS);
    onCleanup(() => clearInterval(timer));
  });

  const summary = createMemo<DashboardSummary>(() => {
    const value = resource();
    return value === undefined ? EMPTY_SUMMARY : value;
  });
  const metrics = createMemo<OverviewMetric[]>(() => deriveMetrics(summary()));
  const isLoading = () => resource.loading;
  const isError = () => resource.error !== undefined;
  // Endpoint failures surface through the same bounded info the fatal path
  // uses, so a partial console outage is visible instead of silent nulls.
  const errorInfo = createMemo(() => {
    if (resource.error) return consoleFailure(resource.error);
    const first = summary().failures[0];
    return first ? { code: first.code, message: first.message, degraded: first.degraded } : null;
  });
  const degradedLabels = createMemo(() => summary().failures.map((failure) => failure.label));

  return (
    <div class="dashboard-page animate-fade-in space-y-5">
      <header class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 class="text-xl font-bold text-[var(--text-1)]">Overview</h2>
          <p class="mt-1 text-xs text-[var(--text-2)]">
            Live telemetry snapshot of the API and provider fleet.
          </p>
        </div>
        <Show when={summary().fetchedAt}>
          {(fetched) => (
            <Badge tone="neutral" className="font-mono">
              Fetched {fetched()}
            </Badge>
          )}
        </Show>
      </header>

      <section aria-label="Key metrics">
        <Show
          when={!isLoading()}
          fallback={
            <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <For each={[0, 1, 2, 3]}>{(index) => <MetricCardSkeleton label={`Metric ${index}`} />}</For>
            </div>
          }
        >
          <Show
            when={!isError()}
            fallback={
              <StatePanel
                kind={errorInfo()?.degraded ? "degraded" : "error"}
                title={errorInfo()?.degraded ? "Summary degraded" : "Failed to load overview"}
                description={errorInfo()?.message ?? "Unknown error"}
                action={
                  <Button variant="secondary" onClick={() => void refetch()}>
                    Retry
                  </Button>
                }
              />
            }
          >
            <Show when={summary().failures.length > 0}>
              <StatePanel
                kind={errorInfo()?.degraded ? "degraded" : "error"}
                title="Summary degraded"
                description={`${degradedLabels().join(", ")} unavailable — ${errorInfo()?.message ?? "unknown error"}`}
                action={
                  <Button variant="secondary" onClick={() => void refetch()}>
                    Retry
                  </Button>
                }
                className="mb-3"
              />
            </Show>
            <div class="grid animate-fade-in grid-cols-2 gap-3 lg:grid-cols-4">
              <For each={metrics()}>
                {(metric) => {
                  const Icon = METRIC_ICONS[metric.key as keyof typeof METRIC_ICONS] ?? Activity;
                  return (
                    <MetricCard
                      label={metric.label}
                      value={renderMetricValue(metric)}
                      description={metric.description}
                      icon={Icon}
                      tone={metric.tone}
                    />
                  );
                }}
              </For>
            </div>
          </Show>
        </Show>
      </section>

      <section class="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card density="compact" className="animate-fade-in lg:col-span-2">
          <CardHeader title="System health" icon={Server} iconColor="#0a84ff" sub="Uptime and API status" />
          <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Show when={summary().uptime !== null} fallback={<span class="text-xs text-[var(--text-3)]">—</span>}>
              <div class="rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-3">
                <div class="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Uptime</div>
                <div class="mt-1 text-lg font-bold tabular-nums">{summary().uptime}</div>
              </div>
            </Show>
            <Show when={summary().activeProviders !== null}>
              <div class="rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-3">
                <div class="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Active providers</div>
                <div class="mt-1 text-lg font-bold tabular-nums">{formatNumber(summary().activeProviders)}</div>
              </div>
            </Show>
            <div class="rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-3">
              <div class="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Memory</div>
              <div class="mt-1 text-lg font-bold tabular-nums">{formatNumber(summary().memoryMb)} MB</div>
            </div>
          </div>
        </Card>

        <ErrorList
          errors={summary().recentErrors}
          loading={isLoading()}
          limit={10}
          className="lg:col-span-1"
          emptyMessage="No errors in the last 24 hours."
        />
      </section>
    </div>
  );
}
