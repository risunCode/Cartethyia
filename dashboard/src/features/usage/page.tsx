/* @jsxImportSource solid-js */

import { Activity, ArrowDownToLine, ArrowUpFromLine, Database, DollarSign, Radio, TriangleAlert, Wrench } from "lucide-solid";
import { For, Show, createMemo, createSignal, type Accessor } from "solid-js";
import { Dynamic } from "solid-js/web";
import { useSearchParams } from "@solidjs/router";
import { useInFlightSnapshot } from "../../composables/observability/use-inflight-stream";
import { useProviders } from "../../components/model-picker";
import { useUsageResource, type ClientDistributionResource } from "../../composables/usage/use-usage-resource";
import { ClientDistribution } from "./client-distribution";
import { Badge } from "../../components/ui/badge";
import { Card, CardHeader } from "../../components/ui/card";
import { Select, Tabs } from "../../components/ui/tabs";
import { StatePanel } from "../../components/ui/state";
import { formatNumber, formatTokens, formatUsd } from "../../lib/format";
import { qk } from "../../lib/query-keys";

type Period = "1h" | "24h" | "7d" | "30d" | "all";
type Metric = "requests" | "tokens" | "cached";
type Dimension = "model" | "provider" | "key";
type BreakdownLimit = "5" | "10" | "all";
type BreakdownMetric = "tokens" | "costs";

interface Summary {
  requests: number | null;
  inputTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
  errors: number | null;
  avgDurationMs: number | null;
  estimatedCostUsd: number | null;
  partial: boolean;
}

interface SummaryResponse {
  period: Period;
  totals: Summary;
}

interface ChartBucket {
  t: string;
  requests: number;
  input: number | null;
  cached: number | null;
  output: number | null;
}

interface CacheRow {
  name: string;
  requests: number;
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  hitRate: number;
}

interface CacheSummary {
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  hitRate: number;
  rows: CacheRow[];
}

interface ByRow {
  name: string;
  requests: number | null;
  input: number | null;
  output: number | null;
  cached: number | null;
  total: number | null;
  errors: number | null;
  costUsd: number | null;
}

function useProviderNames(): Accessor<ReadonlyMap<string, string>> {
  const providersQuery = useProviders();
  return createMemo(() => new Map((providersQuery.data?.items ?? []).map((provider) => [provider.id.toLowerCase(), provider.name])));
}

function providerDisplayName(value: string | null | undefined, names: ReadonlyMap<string, string>): string {
  if (!value) return "—";
  return names.get(value.toLowerCase()) ?? value;
}

const STAT_CARDS = [
  { key: "requests", label: "Requests", note: "All routed requests", icon: Activity, color: "#0a84ff", format: formatNumber, tone: "accent" },
  { key: "inputTokens", label: "Input tokens", note: "Prompt tokens", icon: ArrowDownToLine, color: "#64d2ff", format: formatTokens, tone: "info" },
  { key: "cachedTokens", label: "Cached tokens", note: "Read from cache", icon: Database, color: "#bf5af2", format: formatTokens, tone: "accent" },
  { key: "outputTokens", label: "Output tokens", note: "Completion tokens", icon: ArrowUpFromLine, color: "#30d158", format: formatTokens, tone: "success" },
  { key: "errors", label: "Errors", note: "Failed requests", icon: TriangleAlert, color: "#ff453a", format: formatNumber, tone: "danger" },
  { key: "estimatedCostUsd", label: "Est. cost", note: "Estimated, not billing", icon: DollarSign, color: "#ffd60a", format: formatUsd, tone: "warning" },
] as const;

const PERIOD_OPTIONS = [
  { value: "1h", label: "1h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "all" },
];

function asPeriod(value: string | undefined): Period {
  return value === "1h" || value === "7d" || value === "30d" || value === "all" ? value : "24h";
}

function asMetric(value: string | undefined): Metric {
  return value === "tokens" || value === "cached" ? value : "requests";
}

function asDimension(value: string | undefined): Dimension {
  return value === "provider" || value === "key" ? value : "model";
}

function ChartPanel(props: { period: Period; metric: Metric }) {
  const query = useUsageResource<{ buckets: ChartBucket[] }>(() => qk.usage.chart(props.period), () => `/usage/chart?period=${props.period}`);
  const points = createMemo(() => query.data?.buckets ?? []);
  const max = createMemo(() => Math.max(1, ...points().map((bucket) => bucket.requests)));
  const linePoints = createMemo(() => points().map((bucket, index) => {
    const x = points().length <= 1 ? 400 : (index / (points().length - 1)) * 760 + 20;
    const y = 210 - (bucket.requests / max()) * 180;
    return { x, y, bucket };
  }));
  const line = createMemo(() => linePoints().map((point) => `${point.x},${point.y}`).join(" "));
  const area = createMemo(() => {
    const current = linePoints();
    if (current.length === 0) return "";
    return `${current[0].x},220 ${current.map((point) => `${point.x},${point.y}`).join(" ")} ${current[current.length - 1].x},220`;
  });

  return (
    <Show when={!query.isLoading} fallback={<div class="h-56 animate-pulse rounded-xl bg-[var(--surface-muted)]" aria-label="Loading usage chart" />}>
      <Show when={!query.isError} fallback={<StatePanel kind="degraded" title="Usage telemetry is degraded" description="The daemon did not provide chart data for this period." density="compact" />}>
        <Show when={props.metric === "requests"} fallback={<StatePanel kind="degraded" title="Metric unavailable" description="Token and cache evidence is not available from the daemon telemetry contract." density="compact" />}>
          <Show when={points().length > 0} fallback={<StatePanel kind="empty" title="No request telemetry" description="There is no request telemetry for this period." density="compact" />}>
            <div class="h-56 w-full" role="img" aria-label={`Requests per bucket for ${props.period}`}>
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
                <For each={linePoints()}>{(point) => <circle cx={point.x} cy={point.y} r="3" fill="var(--accent)" class="opacity-0 transition-opacity hover:opacity-100"><title>{`${point.bucket.t}: ${formatNumber(point.bucket.requests)} requests`}</title></circle>}</For>
              </svg>
              <div class="flex justify-between px-2 text-[10px] text-[var(--text-3)]"><span>{points()[0]?.t.slice(5, 16)}</span><span>{points()[points().length - 1]?.t.slice(5, 16)}</span></div>
            </div>
          </Show>
        </Show>
      </Show>
    </Show>
  );
}

function BreakdownSnapshot(props: { period: Period; dimension: Dimension; onDimensionChange: (value: string) => void }) {
  const providerNames = useProviderNames();
  const query = useUsageResource<{ rows: ByRow[] }>(() => qk.usage.by(props.period, props.dimension), () => `/usage/by-${props.dimension}?period=${props.period}`);
  const rows = createMemo(() => (query.data?.rows ?? []).slice(0, 6));
  const maxTotal = createMemo(() => Math.max(1, ...rows().flatMap((row) => row.total === null ? [] : [row.total])));
  const totalRequests = createMemo(() => rows().reduce((sum, row) => sum + (row.requests ?? 0), 0));

  return (
    <Card density="compact">
      <CardHeader title="Breakdown" icon={Wrench} iconColor="#bf5af2" sub={`${formatNumber(totalRequests())} requests · ${formatTokens(maxTotal())} tokens`}>
        <div class="flex items-center gap-1">
          <For each={[["model", "Model"], ["provider", "Provider"], ["key", "Key"]] as const}>{([id, label]) => <button type="button" onClick={() => props.onDimensionChange(id)} class={`rounded-full px-3 py-1 text-[10px] font-semibold transition-colors ${props.dimension === id ? "bg-[var(--accent)] text-white" : "bg-[var(--hover)] text-[var(--text-2)] hover:bg-[var(--surface-muted)]"}`}>{label}</button>}</For>
        </div>
      </CardHeader>
      <Show when={!query.isLoading} fallback={<div class="space-y-2"><div class="h-10 animate-pulse rounded-xl bg-[var(--surface-muted)]" /><div class="h-10 animate-pulse rounded-xl bg-[var(--surface-muted)]" /></div>}>
        <Show when={!query.isError} fallback={<StatePanel kind="degraded" title="Breakdown unavailable" description="Usage breakdown is unavailable from the daemon telemetry contract." density="compact" />}>
          <Show when={rows().length > 0} fallback={<StatePanel kind="empty" title="No usage" description="There is no usage for this period." density="compact" />}>
            <div class="space-y-2 px-1">
              <For each={rows()}>{(row) => {
                const pct = row.total !== null && maxTotal() > 0 ? Math.max(2, (row.total / maxTotal()) * 100) : 2;
                const displayName = props.dimension === "provider" ? providerDisplayName(row.name, providerNames()) : row.name;
                return <div class="relative overflow-hidden rounded-xl border border-[var(--inner-border)] bg-[var(--hover)]"><div class="absolute inset-y-0 left-0 z-0 bg-gradient-to-r from-[var(--accent)]/20 via-[var(--accent)]/15 to-transparent" style={{ width: `${pct}%` }} /><div class="relative z-[1] flex items-center justify-between gap-2 px-3 py-2.5"><span class="min-w-0 flex-1 truncate font-mono text-[11px] font-semibold">{displayName}</span><span class="shrink-0 text-right text-[10px] font-medium tabular-nums text-[var(--text-2)]">{formatNumber(row.requests)} req</span><span class="shrink-0 text-right text-[11px] font-semibold tabular-nums text-[#bf5af2]">{formatTokens(row.total)}</span></div></div>;
              }}</For>
            </div>
          </Show>
        </Show>
      </Show>
    </Card>
  );
}

function formatUsageScale(value: number, maxValue: number, mode: BreakdownMetric): string {
  if (mode === "costs") {
    if (value === 0) return "$0";
    if (value < 0.01) return "<$0.01";
    return `$${value.toFixed(value >= 10 ? 0 : 2)}`;
  }
  if (value === 0) return "0";
  const unit = maxValue >= 1_000_000_000 ? 1_000_000_000 : maxValue >= 1_000_000 ? 1_000_000 : maxValue >= 1_000 ? 1_000 : 1;
  const suffix = unit === 1_000_000_000 ? "B" : unit === 1_000_000 ? "M" : unit === 1_000 ? "K" : "";
  const scaled = value / unit;
  return `${scaled >= 10 || unit === 1 ? scaled.toFixed(0) : scaled.toFixed(1)}${suffix}`;
}

function BreakdownBarChart(props: { rows: ByRow[]; dimension: Dimension; mode: BreakdownMetric; limit: BreakdownLimit; providerNames: ReadonlyMap<string, string> }) {
  const [hovered, setHovered] = createSignal<string | null>(null);
  const sortedRows = createMemo(() => props.rows.filter((row) => props.mode === "costs" ? row.costUsd !== null && row.costUsd > 0 : true).sort((a, b) => props.mode === "costs" ? (b.costUsd ?? 0) - (a.costUsd ?? 0) : (b.total ?? 0) - (a.total ?? 0)));
  const chartRows = createMemo(() => props.limit === "all" ? sortedRows() : sortedRows().slice(0, Number(props.limit)));
  const maxValue = createMemo(() => Math.max(1, ...chartRows().map((row) => props.mode === "costs" ? (row.costUsd ?? 0) : (row.total ?? 0))));

  return <div class="relative mb-3 rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-3">
    <div class="mb-2 flex items-center justify-between gap-2"><div><div class="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-2)]">{props.mode === "costs" ? "Estimated cost share" : `Usage by ${props.dimension}`}</div><div class="mt-0.5 text-[10px] text-[var(--text-3)]">Showing {chartRows().length === sortedRows().length ? "all" : chartRows().length} of {sortedRows().length} · scale uses {props.mode === "costs" ? "USD" : "K / M / B"} · hover a bar for details</div></div><Badge tone={props.mode === "costs" ? "warn" : "info"}>{props.mode === "costs" ? "USD" : "tokens"}</Badge></div>
    <Show when={chartRows().length > 0} fallback={<div class="grid min-h-[180px] place-items-center text-center text-xs text-[var(--text-3)]">{props.mode === "costs" ? "No priced usage for this period." : "No usage for this period."}</div>}>
      <div class="space-y-2.5"><For each={chartRows()}>{(row) => {
        const displayName = props.dimension === "provider" ? providerDisplayName(row.name, props.providerNames) : row.name;
        const value = props.mode === "costs" ? (row.costUsd ?? 0) : (row.total ?? 0);
        const width = value > 0 ? `${Math.max(2, (value / maxValue()) * 100)}%` : "0%";
        const cached = row.cached ?? 0;
        const cachedWidth = cached > 0 ? `${Math.max(1, (cached / maxValue()) * 100)}%` : "0%";
        const tooltip = `${displayName} · ${props.mode === "costs" ? `estimated cost ${formatUsd(row.costUsd)}` : `total ${formatTokens(row.total)}`}`;
        return <div class="group relative" tabIndex="0" onMouseEnter={() => setHovered(row.name)} onFocus={() => setHovered(row.name)} onMouseLeave={() => setHovered(null)} onBlur={() => setHovered(null)}><div class="mb-1 flex items-center justify-between gap-2 text-[10px]"><span class="min-w-0 truncate font-mono font-semibold text-[var(--text-2)]" title={displayName}>{displayName}</span><span class="shrink-0 font-semibold tabular-nums text-[var(--text-1)]">{props.mode === "costs" ? formatUsd(row.costUsd) : formatTokens(row.total)}</span></div><div class="relative h-4 overflow-hidden rounded-full bg-[var(--surface-muted)] ring-1 ring-inset ring-[var(--inner-border)]" title={tooltip} role="img" aria-label={tooltip}>{value > 0 && <div class="absolute inset-y-0 left-0 rounded-full bg-[var(--accent)]" style={{ width }} />}{props.mode === "tokens" && cached > 0 && <div class="absolute inset-y-0 left-0 rounded-full bg-[#bf5af2]" style={{ width: cachedWidth }} />}</div><Show when={hovered() === row.name}><div role="tooltip" class="mt-1 rounded-lg border border-[var(--glass-border-2)] bg-[var(--popover-bg)] px-3 py-2 text-[10px] shadow-xl"><div class="truncate font-mono font-semibold text-[var(--text-1)]">{displayName}</div><div class="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[var(--text-2)]"><span>Requests <strong class="text-[var(--text-1)]">{formatNumber(row.requests)}</strong></span><span>Errors <strong class="text-[var(--text-1)]">{formatNumber(row.errors)}</strong></span><span>Input <strong class="text-[var(--text-1)]">{formatTokens(row.input)}</strong></span><span>Cached <strong class="text-[#bf5af2]">{formatTokens(row.cached)}</strong></span><span>Output <strong class="text-[var(--text-1)]">{formatTokens(row.output)}</strong></span><span>{props.mode === "costs" ? "Cost" : "Total"} <strong class="text-[var(--text-1)]">{props.mode === "costs" ? formatUsd(row.costUsd) : formatTokens(row.total)}</strong></span></div></div></Show></div>;
      }}</For></div>
      <div class="mt-3 flex items-center gap-3 text-[10px] text-[var(--text-3)]"><span class="inline-flex items-center gap-1"><i class="size-2 rounded-full bg-[var(--accent)]" />Total usage</span><Show when={props.mode === "tokens"}><span class="inline-flex items-center gap-1"><i class="size-2 rounded-full bg-[#bf5af2]" />Cached</span></Show></div>
      <div class="relative mt-3 h-6 border-t border-[var(--inner-border)]"><For each={[0, 0.25, 0.5, 0.75, 1]}>{(ratio) => <span class={`absolute top-1 text-[9px] tabular-nums text-[var(--text-3)] ${ratio === 0 ? "" : ratio === 1 ? "-translate-x-full" : "-translate-x-1/2"}`} style={{ left: `${ratio * 100}%` }}>{formatUsageScale(maxValue() * ratio, maxValue(), props.mode)}</span>}</For></div>
    </Show>
  </div>;
}

function BreakdownCard(props: { period: Period; dimension: Dimension; onDimensionChange: (value: string) => void }) {
  const providerNames = useProviderNames();
  const [mode, setMode] = createSignal<BreakdownMetric>("tokens");
  const [limit, setLimit] = createSignal<BreakdownLimit>("5");
  const byQuery = useUsageResource<{ rows: ByRow[] }>(() => qk.usage.by(props.period, props.dimension), () => `/usage/by-${props.dimension}?period=${props.period}`);
  const cacheQuery = useUsageResource<CacheSummary & { period: Period }>(() => qk.usage.cache(props.period), () => `/usage/cache?period=${props.period}`, { refetchInterval: 10_000 });
  const rows = createMemo(() => byQuery.data?.rows ?? []);
  const cache = () => cacheQuery.data;

  return <Card className="min-w-0" density="compact"><CardHeader title="Usage breakdown" icon={Database} iconColor="#bf5af2" sub="Cache usage, tokens, and cost share one analytics surface."><div class="flex w-full flex-wrap items-center justify-between gap-1.5 sm:w-auto"><Tabs tabs={[{ id: "tokens", label: "Tokens" }, { id: "costs", label: "Costs" }]} value={mode()} onChange={(value) => setMode(value as BreakdownMetric)} /><Select ariaLabel="Breakdown dimension" value={props.dimension} onChange={props.onDimensionChange} options={[{ value: "model", label: "Usage by model" }, { value: "provider", label: "Usage by provider" }, { value: "key", label: "Usage by API key" }]} /><Select ariaLabel="Breakdown limit" value={limit()} onChange={(value) => setLimit(value as BreakdownLimit)} options={[{ value: "5", label: "Top 5" }, { value: "10", label: "Top 10" }, { value: "all", label: "All" }]} /></div></CardHeader>
    <Show when={!cacheQuery.isError}><span /></Show><Show when={cacheQuery.isError}><p class="mb-3 rounded-lg border border-dashed border-[var(--inner-border)] px-3 py-2 text-xs text-[var(--text-3)]" role="status">Cache telemetry is unavailable from the daemon; token cost evidence remains unknown.</p></Show>
    <div class="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-3"><For each={[["Cache read", formatTokens(cache()?.cachedTokens), "tokens served from cache", "#bf5af2"], ["Cache write", formatTokens(cache()?.cacheWriteTokens), "tokens written to cache", "#65d7df"], ["Hit rate", cache() ? `${cache()!.hitRate.toFixed(1)}%` : "—", "read tokens / input tokens", "#30d158"] as const]}>{([label, value, note, color]) => <div class="rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2.5"><div class="text-[10px] font-semibold uppercase text-[var(--text-2)]">{label}</div><div class="mt-1 text-lg font-bold tracking-tight" style={{ color }}>{value}</div><div class="mt-0.5 text-[10px] text-[var(--text-3)]">{note}</div></div>}</For></div>
    <Show when={mode() === "costs" && rows().some((row) => row.costUsd !== null)}><div class="mb-3 rounded-lg border border-[#ffd60a]/20 bg-[#ffd60a]/[0.06] px-3 py-2 text-[11px] text-[var(--text-2)]">Estimated from published token pricing. Rows with unknown pricing are marked — and excluded from the total.</div></Show>
    <Show when={!byQuery.isLoading} fallback={<div class="h-48 animate-pulse rounded-xl bg-[var(--surface-muted)]" />}><Show when={!byQuery.isError} fallback={<StatePanel kind="degraded" title="Breakdown unavailable" description="Usage breakdown is unavailable from the daemon telemetry contract." density="compact" />}><BreakdownBarChart rows={rows()} dimension={props.dimension} mode={mode()} limit={limit()} providerNames={providerNames()} /></Show></Show>
  </Card>;
}

export function UsagePage() {
  const inFlightSnapshot = useInFlightSnapshot();
  const [searchParams, setSearchParams] = useSearchParams<{ period?: string; metric?: string; dim?: string }>();
  const period = () => asPeriod(searchParams.period);
  const metric = () => asMetric(searchParams.metric);
  const dimension = () => asDimension(searchParams.dim);
  const summaryQuery = useUsageResource<SummaryResponse>(() => qk.usage.summary(period()), () => `/usage/summary?period=${period()}`, { refetchInterval: 10_000 });
  const clientsQuery = useUsageResource<ClientDistributionResource>(() => qk.usage.clients(period()), () => `/usage/clients?period=${period()}`, { refetchInterval: 15_000 });
  const setParam = (key: string, value: string) => setSearchParams({ [key]: value }, { replace: true });
  const isRefreshing = () => (summaryQuery.isFetching && !summaryQuery.isLoading) || (clientsQuery.isFetching && !clientsQuery.isLoading);

  return <div class="dashboard-page space-y-4"><Show when={isRefreshing()}><p class="rounded-lg border border-dashed border-[var(--inner-border)] px-3 py-2 text-xs text-[var(--text-3)]" role="status">Refreshing telemetry; the last safe response remains visible.</p></Show>
    <div class="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6"><For each={STAT_CARDS}>{(card) => <div class="glass min-w-0 rounded-[var(--radius-card)] p-3.5 transition-transform duration-200 hover:-translate-y-0.5"><span class="mb-2.5 grid size-8 place-items-center rounded-[10px]" style={{ background: `${card.color}24`, color: card.color }}><Dynamic component={card.icon} size={15} /></span><div class="text-lg font-bold leading-none tabular-nums sm:text-xl">{summaryQuery.isLoading ? "…" : card.format(summaryQuery.data?.totals?.[card.key] ?? null)}</div><div class="mt-1 text-[10.5px] text-[var(--text-2)]">{card.note}</div><Show when={card.key === "requests"}><span class={`mt-1.5 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${inFlightSnapshot().inFlight > 0 ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "bg-[var(--hover)] text-[var(--text-3)]"}`}><i class={`size-1.5 rounded-full ${inFlightSnapshot().inFlight > 0 ? "animate-pulse bg-[var(--accent)]" : "bg-[var(--text-3)]"}`} />+{inFlightSnapshot().inFlight} in flight</span></Show><Show when={card.key === "estimatedCostUsd" && summaryQuery.data?.totals?.partial}><span class="mt-1 block text-[9px] font-semibold text-[#ffd60a]">partial estimate</span></Show></div>}</For></div>
    <section class="grid grid-cols-1 gap-3.5 lg:grid-cols-2"><Card density="compact"><CardHeader title="Traffic" icon={Radio} sub={`Requests per bucket · ${period()}`}><div class="flex items-center gap-2"><Tabs tabs={[{ id: "requests", label: "Requests" }, { id: "tokens", label: "Tokens" }, { id: "cached", label: "Cached" }]} value={metric()} onChange={(value) => setParam("metric", value)} /><Select ariaLabel="Period" value={period()} onChange={(value) => setParam("period", value)} options={PERIOD_OPTIONS} /></div></CardHeader><ChartPanel period={period()} metric={metric()} /></Card><BreakdownSnapshot period={period()} dimension={dimension()} onDimensionChange={(value) => setParam("dim", value)} /></section>
    <ClientDistribution items={clientsQuery.data?.items ?? []} total={clientsQuery.data?.total ?? null} unknownCount={clientsQuery.data?.unknown ?? null} isLoading={clientsQuery.isLoading} /><BreakdownCard period={period()} dimension={dimension()} onDimensionChange={(value) => setParam("dim", value)} />
  </div>;
}
