import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  Database,
  DollarSign,
  Radio,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useInFlightSnapshot } from "../../hooks/use-inflight-stream";
import { useProviders } from "../../components/model-picker";
import { Badge } from "../../components/ui/badge";
import { Card, CardHeader } from "../../components/ui/card";
import { DataTable } from "../../components/ui/layout";
import { Drawer } from "../../components/ui/drawer";
import { Select, Tabs } from "../../components/ui/tabs";
import { apiGet } from "../../lib/api";
import { formatDuration, formatNumber, formatTime, formatTokens, formatUsd } from "../../lib/format";
import { staggerClass } from "../../lib/motion";
import { qk } from "../../lib/query-keys";

type Period = "1h" | "24h" | "7d" | "30d" | "all";
type Metric = "requests" | "tokens" | "cached";
type Dimension = "model" | "provider" | "key";
type BreakdownMetric = "tokens" | "costs";

interface Summary {
  requests: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  errors: number;
  avgDurationMs: number;
  estimatedCostUsd: number;
  partial: boolean;
}

interface SummaryResponse {
  period: Period;
  totals: Summary;
}

interface ChartBucket {
  t: string;
  requests: number;
  input: number;
  cached: number;
  output: number;
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
  requests: number;
  input: number;
  output: number;
  cached: number;
  total: number;
  errors: number;
  costUsd: number | null;
}

interface RequestRow {
  requestId: string;
  endpoint: string;
  surface: string;
  apiKeyId: string | null;
  apiKeyPrefix: string | null;
  clientIp?: string | null;
  providerId: string | null;
  model: string | null;
  statusCode: number;
  errorKind: string | null;
  mode: "non_stream" | "stream";
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
  clientName: string;
  clientSource: string;
  messageCount: number;
  toolCount: number;
  imageCount: number;
  tfftMs: number | null;
}

function useProviderNames(): ReadonlyMap<string, string> {
  const providersQuery = useProviders();
  return useMemo(() => new Map((providersQuery.data?.items ?? []).map((provider) => [provider.id.toLowerCase(), provider.name])), [providersQuery.data?.items]);
}

function providerDisplayName(value: string | null | undefined, names: ReadonlyMap<string, string>): string {
  if (!value) return "—";
  return names.get(value.toLowerCase()) ?? value;
}

const STAT_CARDS = [
  { key: "requests", label: "Requests", note: "All routed requests", icon: Activity, color: "#0a84ff", format: formatNumber },
  { key: "inputTokens", label: "Input tokens", note: "Prompt tokens", icon: ArrowDownToLine, color: "#64d2ff", format: formatTokens },
  { key: "cachedTokens", label: "Cached tokens", note: "Read from cache", icon: Database, color: "#bf5af2", format: formatTokens },
  { key: "outputTokens", label: "Output tokens", note: "Completion tokens", icon: ArrowUpFromLine, color: "#30d158", format: formatTokens },
  { key: "errors", label: "Errors", note: "Failed requests", icon: TriangleAlert, color: "#ff453a", format: formatNumber },
  { key: "estimatedCostUsd", label: "Est. cost", note: "Estimated, not billing", icon: DollarSign, color: "#ffd60a", format: formatUsd },
] as const satisfies readonly {
  key: keyof Summary;
  label: string;
  note: string;
  icon: typeof Activity;
  color: string;
  format: (value: number | null | undefined) => string;
}[];

const PERIOD_OPTIONS = [
  { value: "1h", label: "1h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "all" },
];

function statusTone(status: number): "ok" | "err" | "warn" {
  if (status === 0) return "warn";
  if (status === 499 || status === 500 || status === 502) return "warn";
  if (status >= 400) return "err";
  return "ok";
}

function statusLabel(status: number): string {
  return status === 0 ? "—" : String(status);
}

function asPeriod(value: string | null): Period {
  return value === "1h" || value === "7d" || value === "30d" || value === "all" ? value : "24h";
}

function asMetric(value: string | null): Metric {
  return value === "tokens" || value === "cached" ? value : "requests";
}

function asDimension(value: string | null): Dimension {
  return value === "provider" || value === "key" ? value : "model";
}


function ChartPanel({ period, metric }: { period: Period; metric: Metric }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: qk.usage.chart(period),
    queryFn: () => apiGet<{ buckets: ChartBucket[] }>(`/usage/chart?period=${period}`),
  });
  if (isLoading) return <div className="h-56 animate-pulse rounded-xl bg-[var(--surface-muted)]" />;
  if (isError) return <p className="py-8 text-center text-sm text-[var(--text-3)]">Failed to load chart data.</p>;
  const buckets = (data?.buckets ?? []).map((bucket) => ({ ...bucket, total: bucket.input + bucket.output }));
  const dataKey = metric === "requests" ? "requests" : metric === "cached" ? "cached" : "total";
  return (
    <div className="h-56">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={buckets} margin={{ top: 8, right: 8, left: -14, bottom: 0 }}>
          <defs><linearGradient id="usageChartFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--accent)" stopOpacity={0.45} /><stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} /></linearGradient></defs>
          <CartesianGrid stroke="var(--inner-border)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="t" tick={{ fontSize: 10, fill: "var(--text-3)" }} tickFormatter={(value: string) => value.slice(5, 16)} axisLine={false} tickLine={false} minTickGap={28} />
          <YAxis tick={{ fontSize: 10, fill: "var(--text-3)" }} axisLine={false} tickLine={false} tickFormatter={(value: number) => formatTokens(value)} />
          <Tooltip contentStyle={{ background: "var(--glass-bg-2)", border: "1px solid var(--glass-border-2)", borderRadius: 12, fontSize: 12, color: "var(--text-1)" }} formatter={(value: number | string) => [formatNumber(Number(value)), metric]} />
          <Area type="monotone" dataKey={dataKey} stroke="var(--accent)" strokeWidth={2} fill="url(#usageChartFill)" isAnimationActive animationDuration={600} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function RequestDetailDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const providerNames = useProviderNames();
  const { data, isLoading } = useQuery({
    queryKey: qk.usage.detail(id),
    queryFn: () => apiGet<RequestRow>(`/usage/requests/${encodeURIComponent(id ?? "")}`),
    enabled: id !== null,
  });
  return (
    <Drawer open={id !== null} onClose={onClose} title="Request Detail">
      {isLoading && (
        <div className="space-y-3">
          <div className="h-6 w-2/3 animate-pulse rounded bg-[var(--surface-muted)]" />
          <div className="h-24 animate-pulse rounded bg-[var(--surface-muted)]" />
          <div className="h-24 animate-pulse rounded bg-[var(--surface-muted)]" />
        </div>
      )}
      {data && (
        <div className="space-y-4 text-sm">
          <div>
            <div className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Request ID</div>
            <div className="mt-1 break-all font-mono text-xs">{data.requestId}</div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Endpoint</div>
              <div className="mt-1 font-mono text-xs">{data.endpoint}</div>
            </div>
            <div>
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Surface</div>
              <div className="mt-1">{data.surface}</div>
            </div>
            <div>
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Provider</div>
              <div className="mt-1">{providerDisplayName(data.providerId, providerNames)}</div>
            </div>
            <div>
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Model</div>
              <div className="mt-1 font-mono text-xs">{data.model ?? "—"}</div>
            </div>
            <div>
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-3)]">API key</div>
              <div className="mt-1 font-mono text-xs">{data.apiKeyPrefix ?? "anonymous"}</div>
            </div>
            <div>
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Client</div>
              <div className="mt-1 font-mono text-xs">{data.clientName || data.clientSource || "—"}</div>
            </div>
            <div>
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Status</div>
              <div className="mt-1">
                <Badge tone={statusTone(data.statusCode)}>{statusLabel(data.statusCode)}</Badge>
                {data.mode === "stream" && <Badge tone="info" className="ml-1.5">stream</Badge>}
              </div>
            </div>
            <div>
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Duration</div>
              <div className="mt-1 tabular-nums">{formatDuration(data.durationMs)}</div>
            </div>
          </div>

          {data.tfftMs != null && (
            <div>
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Time to First Token (TFFT)</div>
              <div className="mt-1 text-base font-bold tabular-nums">{data.tfftMs}ms</div>
            </div>
          )}

          <div>
            <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Tokens</div>
            <div className="grid grid-cols-3 gap-2 rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-3 text-center tabular-nums">
              <div>
                <div className="text-base font-bold">{formatNumber(data.inputTokens)}</div>
                <div className="text-[10.5px] text-[var(--text-3)]">input</div>
              </div>
              <div>
                <div className="text-base font-bold">{formatNumber(data.cachedTokens)}</div>
                <div className="text-[10.5px] text-[var(--text-3)]">cached</div>
              </div>
              <div>
                <div className="text-base font-bold">{formatNumber(data.outputTokens)}</div>
                <div className="text-[10.5px] text-[var(--text-3)]">output</div>
              </div>
            </div>
            <p className="mt-1.5 text-[10.5px] text-[var(--text-3)]">usage source: {data.usageSource} · started {formatTime(data.startedAt)}</p>
          </div>

          <div>
            <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Payload meta</div>
            <div className="space-y-1 rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-3 text-xs">
              <div>messages: {String(data.messageCount ?? "—")}</div>
              <div>images: {String(data.imageCount ?? "—")}</div>
              <div>tools: {String(data.toolCount ?? "—")}</div>
            </div>
          </div>

          {data.errorKind && (
            <div>
              <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Error</div>
              <Badge tone="err">{data.errorKind}</Badge>
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}

function BreakdownSnapshot({ period, dimension, onDimensionChange }: { period: Period; dimension: Dimension; onDimensionChange: (value: string) => void }) {
  const providerNames = useProviderNames();
  const byQuery = useQuery({
    queryKey: qk.usage.by(period, dimension),
    queryFn: () => apiGet<{ rows: ByRow[] }>(`/usage/by-${dimension}?period=${period}`),
  });
  const rows = (byQuery.data?.rows ?? []).slice(0, 6);
  const maxTotal = rows.length > 0 ? Math.max(...rows.map((r) => r.total)) : 1;
  const totalRequests = rows.reduce((sum, r) => sum + r.requests, 0);

  return (
    <Card density="compact">
      <CardHeader title="Breakdown" icon={Wrench} iconColor="#bf5af2" sub={`${formatNumber(totalRequests)} requests · ${formatTokens(maxTotal)} tokens`}>
        <div className="flex items-center gap-1">
          {([["model", "Model"], ["provider", "Provider"], ["key", "Key"]] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => onDimensionChange(id)}
              className={`rounded-full px-3 py-1 text-[10px] font-semibold transition-colors ${dimension === id ? "bg-[var(--accent)] text-white" : "bg-[var(--hover)] text-[var(--text-2)] hover:bg-[var(--surface-muted)]"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </CardHeader>
      <div className="space-y-2 px-1">
        {byQuery.isLoading && <div className="space-y-2"><div className="h-10 animate-pulse rounded-xl bg-[var(--surface-muted)]" /><div className="h-10 animate-pulse rounded-xl bg-[var(--surface-muted)]" /></div>}
        {!byQuery.isLoading && rows.length === 0 && <div className="grid min-h-[180px] place-items-center rounded-xl border border-dashed border-[var(--inner-border)] px-3 py-8 text-center text-xs text-[var(--text-3)]">No usage for this period.</div>}
        {rows.map((row, index) => {
          const pct = maxTotal > 0 ? Math.max(2, (row.total / maxTotal) * 100) : 2;
          const displayName = dimension === "provider" ? providerDisplayName(row.name, providerNames) : row.name;
          return (
            <div
              key={row.name}
              {...staggerClass(index)}
              className="relative overflow-hidden rounded-xl border border-[var(--inner-border)] bg-[var(--hover)]"
            >
              {/* Progress bar background */}
              <div className="absolute inset-y-0 left-0 z-0" style={{ width: `${pct}%` }}>
                <div className="h-full w-full bg-gradient-to-r from-[var(--accent)]/20 via-[var(--accent)]/15 to-transparent" />
              </div>
              {/* Content */}
              <div className="relative z-[1] flex items-center justify-between gap-2 px-3 py-2.5">
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-semibold">{displayName}</span>
                <span className="shrink-0 text-right text-[10px] font-medium tabular-nums text-[var(--text-2)]">{formatNumber(row.requests)} req</span>
                <span className="shrink-0 text-right text-[11px] font-semibold tabular-nums text-[#bf5af2]">{formatTokens(row.total)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function BreakdownCard({ period, dimension, onDimensionChange }: { period: Period; dimension: Dimension; onDimensionChange: (value: string) => void }) {
  const providerNames = useProviderNames();
  const [mode, setMode] = useState<BreakdownMetric>("tokens");
  const byQuery = useQuery({
    queryKey: qk.usage.by(period, dimension),
    queryFn: () => apiGet<{ rows: ByRow[] }>(`/usage/by-${dimension}?period=${period}`),
  });
  const cacheQuery = useQuery({
    queryKey: qk.usage.cache(period),
    queryFn: () => apiGet<CacheSummary & { period: Period }>(`/usage/cache?period=${period}`),
    refetchInterval: 10_000,
  });
  const rows = byQuery.data?.rows ?? [];
  const cache = cacheQuery.data;
  const modeIsCosts = mode === "costs";

  return (
    <Card className="min-w-0" density="compact">
      <CardHeader title="Usage breakdown" icon={Database} iconColor="#bf5af2" sub="Cache usage, tokens, and cost share one analytics surface.">
        <div className="flex w-full items-center justify-between gap-1.5 sm:w-auto">
          <Tabs tabs={[{ id: "tokens", label: "Tokens" }, { id: "costs", label: "Costs" }]} value={mode} onChange={(value) => setMode(value as BreakdownMetric)} />
          <Select ariaLabel="Breakdown dimension" value={dimension} onChange={onDimensionChange} options={[{ value: "model", label: "Usage by model" }, { value: "provider", label: "Usage by provider" }, { value: "key", label: "Usage by API key" }]} />
        </div>
      </CardHeader>
      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        {[
          ["Cache read", formatTokens(cache?.cachedTokens), "tokens served from cache", "#bf5af2"],
          ["Cache write", formatTokens(cache?.cacheWriteTokens), "tokens written to cache", "#65d7df"],
          ["Hit rate", cache ? `${cache.hitRate.toFixed(1)}%` : "—", "read tokens / input tokens", "#30d158"],
        ].map(([label, value, note, color]) => (
          <div key={label} className="rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2.5"><div className="text-[10px] font-semibold uppercase text-[var(--text-2)]">{label}</div><div className="mt-1 text-lg font-bold tracking-tight" style={{ color }}>{value}</div><div className="mt-0.5 text-[10px] text-[var(--text-3)]">{note}</div></div>
        ))}
      </div>
      {modeIsCosts && !rows.every((r) => r.costUsd === null) && (
        <div className="mb-3 rounded-lg border border-[#ffd60a]/20 bg-[#ffd60a]/[0.06] px-3 py-2 text-[11px] text-[var(--text-2)]">Estimated from published token pricing. Rows with unknown pricing are marked — and excluded from the total.</div>
      )}
      <div className="overflow-x-auto rounded-xl border border-[var(--inner-border)]">
        <DataTable minWidth={modeIsCosts ? 780 : 680} label="Usage breakdown">
          <thead><tr className="border-b border-[var(--inner-border)] text-left text-[10px] uppercase tracking-wider text-[var(--text-3)]"><th className="px-3 py-2 font-semibold">{dimension === "model" ? "Model" : dimension === "provider" ? "Provider" : "API key"}</th><th className="px-3 py-2 text-right font-semibold">Requests</th><th className="px-3 py-2 text-right font-semibold">Errors</th><th className="px-3 py-2 text-right font-semibold">Input</th><th className="px-3 py-2 text-right font-semibold">Cached</th><th className="px-3 py-2 text-right font-semibold">Output</th><th className="px-3 py-2 text-right font-semibold">Total</th>{modeIsCosts && <th className="px-3 py-2 text-right font-semibold">Cost</th>}</tr></thead>
          <tbody>
            {byQuery.isLoading && <tr><td colSpan={modeIsCosts ? 8 : 7} className="px-3 py-8 text-center text-xs text-[var(--text-3)]">Loading breakdown…</td></tr>}
            {!byQuery.isLoading && rows.length === 0 && <tr><td colSpan={modeIsCosts ? 8 : 7} className="px-3 py-8 text-center text-xs text-[var(--text-3)]">No usage for this period.</td></tr>}
            {rows.slice(0, 25).map((row, index) => (
              <tr key={row.name} {...staggerClass(index)} className="border-b border-[var(--inner-border)] last:border-0 hover:bg-[var(--hover)]"><td className="max-w-[260px] truncate px-3 py-2.5 font-mono text-xs font-semibold">{dimension === "provider" ? providerDisplayName(row.name, providerNames) : row.name}</td><td className="px-3 py-2.5 text-right tabular-nums">{formatNumber(row.requests)}</td><td className="px-3 py-2.5 text-right tabular-nums text-[var(--red)]">{row.errors > 0 ? formatNumber(row.errors) : "—"}</td><td className="px-3 py-2.5 text-right tabular-nums">{modeIsCosts ? "—" : formatTokens(row.input)}</td><td className="px-3 py-2.5 text-right tabular-nums text-[#bf5af2]">{modeIsCosts ? "—" : formatTokens(row.cached)}</td><td className="px-3 py-2.5 text-right tabular-nums">{modeIsCosts ? "—" : formatTokens(row.output)}</td><td className="px-3 py-2.5 text-right font-semibold tabular-nums">{modeIsCosts ? "—" : formatTokens(row.total)}</td>{modeIsCosts && <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-[#ffd60a]">{row.costUsd != null ? formatUsd(row.costUsd) : "—"}</td>}</tr>
            ))}
          </tbody>
        </DataTable>
      </div>
    </Card>
  );
}

export function UsagePage() {
  const inFlightSnapshot = useInFlightSnapshot();
  const inFlight = inFlightSnapshot.inFlight;
  const [searchParams, setSearchParams] = useSearchParams();
  const period = asPeriod(searchParams.get("period"));
  const metric = asMetric(searchParams.get("metric"));
  const dimension = asDimension(searchParams.get("dim"));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const summaryQuery = useQuery({
    queryKey: qk.usage.summary(period),
    queryFn: () => apiGet<SummaryResponse>(`/usage/summary?period=${period}`),
    refetchInterval: 10_000,
  });
  const summary = summaryQuery.data?.totals;

  const requestsQuery = useQuery({
    queryKey: qk.usage.recentRequests,
    queryFn: () => apiGet<{ items: RequestRow[] }>("/usage/requests?limit=10"),
    refetchInterval: 5_000,
  });
  const requestItems = (requestsQuery.data?.items ?? []).filter((r) => r.statusCode > 0);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    next.set(key, value);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="dashboard-page space-y-4">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        {STAT_CARDS.map((card, index) => (
          <div key={card.key} {...staggerClass(index)} className="glass min-w-0 rounded-[var(--radius-card)] p-3.5 transition-transform duration-200 hover:-translate-y-0.5">
            <span className="mb-2.5 grid size-8 place-items-center rounded-[10px]" style={{ background: `${card.color}24`, color: card.color }}><card.icon size={15} /></span>
            <div className="text-lg font-bold leading-none tabular-nums sm:text-xl">{summaryQuery.isLoading ? "…" : card.format(summary?.[card.key] ?? null)}</div>
            <div className="mt-1 text-[10.5px] text-[var(--text-2)]">{card.note}</div>
            {card.key === "requests" && <span className={`mt-1.5 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${inFlight > 0 ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "bg-[var(--hover)] text-[var(--text-3)]"}`}><i className={`size-1.5 rounded-full ${inFlight > 0 ? "animate-pulse bg-[var(--accent)]" : "bg-[var(--text-3)]"}`} />+{inFlight} in flight</span>}
            {card.key === "estimatedCostUsd" && summary?.partial && <span className="mt-1 block text-[9px] font-semibold text-[#ffd60a]">partial estimate</span>}
          </div>
        ))}
      </div>

      <section className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
        <Card density="compact">
          <CardHeader title="Traffic" icon={Radio} sub={`Requests per bucket · ${period}`}>
            <div className="flex items-center gap-2">
              <Tabs tabs={[{ id: "requests", label: "Requests" }, { id: "tokens", label: "Tokens" }, { id: "cached", label: "Cached" }]} value={metric} onChange={(value) => setParam("metric", value)} />
              <Select ariaLabel="Period" value={period} onChange={(value) => setParam("period", value)} options={PERIOD_OPTIONS} />
            </div>
          </CardHeader>
          <ChartPanel period={period} metric={metric} />
        </Card>

        <BreakdownSnapshot period={period} dimension={dimension} onDimensionChange={(value) => setParam("dim", value)} />
      </section>

      <Card density="compact">
        <CardHeader title="Requests" icon={Activity} sub="Newest first · scroll to browse request history">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[rgba(48,209,88,0.14)] px-2.5 py-1 text-[11px] font-semibold text-[#1fa84a] dark:text-[var(--green)]">
            <Radio size={11} className="animate-pulse" />
            Live
          </span>
        </CardHeader>

        <div className="max-h-[560px] overflow-x-auto overflow-y-auto rounded-xl border border-[var(--inner-border)]">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-[var(--inner-border)] text-left text-[10.5px] uppercase tracking-wider text-[var(--text-3)]">
                <th className="px-3 py-2 font-semibold">Time</th>
                <th className="px-3 py-2 font-semibold">Key</th>
                <th className="px-3 py-2 font-semibold">Model</th>
                <th className="px-3 py-2 font-semibold">Mode</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2 text-right font-semibold">In</th>
                <th className="px-3 py-2 text-right font-semibold">Out</th>
                <th className="px-3 py-2 text-right font-semibold">Total</th>
                <th className="px-3 py-2 text-right font-semibold">TFFT</th>
                <th className="px-3 py-2 text-right font-semibold">Dur</th>
              </tr>
            </thead>
            <tbody>
              {requestsQuery.isLoading && (
                <tr><td colSpan={10} className="px-3 py-6"><div className="h-5 animate-pulse rounded bg-[var(--surface-muted)]" /></td></tr>
              )}
              {!requestsQuery.isLoading && requestItems.length === 0 && (
                <tr><td colSpan={10} className="px-3 py-8 text-center text-[var(--text-3)]">No requests recorded for this period.</td></tr>
              )}
              {requestItems.map((row) => (
                <tr
                  key={row.requestId}
                  onClick={() => setSelectedId(row.requestId)}
                  className="cursor-pointer border-b border-[var(--inner-border)] transition-colors last:border-0 hover:bg-[var(--hover)]"
                >
                  <td className="px-3 py-2.5 tabular-nums text-[var(--text-2)]">{formatTime(row.startedAt)}</td>
                  <td className="max-w-[160px] truncate px-3 py-2.5 font-mono">{row.apiKeyPrefix ?? "anon"}</td>
                  <td className="max-w-[200px] truncate px-3 py-2.5 font-mono">{row.model ?? "—"}</td>
                  <td className="px-3 py-2.5"><Badge tone={row.mode === "stream" ? "info" : "default"}>{row.mode === "stream" ? "stream" : "json"}</Badge></td>
                  <td className="px-3 py-2.5"><Badge tone={statusTone(row.statusCode)}>{statusLabel(row.statusCode)}</Badge></td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{formatNumber(row.inputTokens)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{formatNumber(row.outputTokens)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{formatNumber(row.totalTokens)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-[var(--text-2)]">{row.tfftMs != null ? `${row.tfftMs}ms` : "—"}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-[var(--text-2)]">{formatDuration(row.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex items-center justify-between">
          <span className="text-[11px] text-[var(--text-3)]">Showing {requestItems.length} most recent requests</span>
        </div>
      </Card>

      <BreakdownCard period={period} dimension={dimension} onDimensionChange={(value) => setParam("dim", value)} />
      <RequestDetailDrawer id={selectedId} onClose={() => setSelectedId(null)} />
    </div>
  );
}
