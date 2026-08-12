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
import { createPortal } from "react-dom";
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
import { useUsageResource } from "./hooks/use-usage-resource";
import { useProviders } from "../../components/model-picker";
import { Badge } from "../../components/ui/badge";
import { Card, CardHeader } from "../../components/ui/card";
import { Drawer } from "../../components/ui/drawer";
import { Select, Tabs } from "../../components/ui/tabs";
import { formatDuration, formatNumber, formatTime, formatTokens, formatUsd } from "../../lib/format";
import { qk } from "../../lib/query-keys";

type Period = "1h" | "24h" | "7d" | "30d" | "all";
type Metric = "requests" | "tokens" | "cached";
type Dimension = "model" | "provider" | "key";
type BreakdownLimit = "5" | "10" | "all";
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
  routing: {
    requestedModel: string | null;
    mappedModel: string | null;
    upstreamModel: string | null;
    wireSurface: string | null;
    errorMessage: string | null;
  };
  messageCount: number;
  toolCount: number;
  imageCount: number;
  tfftMs: number | null;
  payloads?: {
    clientRequest: { text: string; truncated: boolean; originalBytes: number; capturedBytes: number } | null;
    providerRequest: { text: string; truncated: boolean; originalBytes: number; capturedBytes: number } | null;
    providerResponse: { text: string; truncated: boolean; originalBytes: number; capturedBytes: number } | null;
    clientResponse: { text: string; truncated: boolean; originalBytes: number; capturedBytes: number } | null;
  } | null;
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
  const { data, isLoading, isError } = useUsageResource<{ buckets: ChartBucket[] }>(qk.usage.chart(period), `/usage/chart?period=${period}`);
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
  const { data, isLoading } = useUsageResource<RequestRow>(qk.usage.detail(id), `/usage/requests/${encodeURIComponent(id ?? "")}`, { enabled: id !== null });
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

          {data.routing && (
            <div>
              <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Route resolution</div>
              <div className="grid grid-cols-2 gap-2 rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-3 text-xs">
                <div><div className="text-[10px] text-[var(--text-3)]">Client model</div><div className="mt-0.5 break-all font-mono">{data.routing.requestedModel ?? "—"}</div></div>
                <div><div className="text-[10px] text-[var(--text-3)]">Mapped route</div><div className="mt-0.5 break-all font-mono">{data.routing.mappedModel ?? "—"}</div></div>
                <div><div className="text-[10px] text-[var(--text-3)]">Upstream model</div><div className="mt-0.5 break-all font-mono">{data.routing.upstreamModel ?? "—"}</div></div>
                <div><div className="text-[10px] text-[var(--text-3)]">Wire surface</div><div className="mt-0.5 font-mono">{data.routing.wireSurface ?? "—"}</div></div>
              </div>
            </div>
          )}
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
          {data.payloads && (
            <div>
              <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Payloads</div>
              <div className="space-y-1.5">
                {([
                  ["Client request", data.payloads.clientRequest],
                  ["Provider request (translated)", data.payloads.providerRequest],
                  ["Provider response (raw)", data.payloads.providerResponse],
                  ["Client response (final)", data.payloads.clientResponse],
                ] as const).map(([label, payload]) => payload === null ? null : (
                  <details key={label} className="rounded-xl border border-[var(--inner-border)] bg-[var(--hover)]">
                    <summary className="cursor-pointer px-3 py-2 text-xs font-medium">{label} · {payload.truncated ? "truncated" : "captured"} · {payload.capturedBytes} B</summary>
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words border-t border-[var(--inner-border)] px-3 py-2 font-mono text-[10px] text-[var(--text-2)]">{payload.text}</pre>
                  </details>
                ))}
              </div>
            </div>
          )}

          {data.errorKind && (
            <div>
              <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Error</div>
              <Badge tone="err">{data.errorKind}</Badge>
              {data.routing?.errorMessage && <p className="mt-1.5 break-words text-xs text-[var(--text-2)]">{data.routing.errorMessage}</p>}
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}

function BreakdownSnapshot({ period, dimension, onDimensionChange }: { period: Period; dimension: Dimension; onDimensionChange: (value: string) => void }) {
  const providerNames = useProviderNames();
  const byQuery = useUsageResource<{ rows: ByRow[] }>(qk.usage.by(period, dimension), `/usage/by-${dimension}?period=${period}`);
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
        {rows.map((row) => {
          const pct = maxTotal > 0 ? Math.max(2, (row.total / maxTotal) * 100) : 2;
          const displayName = dimension === "provider" ? providerDisplayName(row.name, providerNames) : row.name;
          return (
            <div
              key={row.name}
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

function BreakdownBarChart({ rows, dimension, mode, limit, providerNames }: { rows: ByRow[]; dimension: Dimension; mode: BreakdownMetric; limit: BreakdownLimit; providerNames: ReadonlyMap<string, string> }) {
  const [hoveredRow, setHoveredRow] = useState<{ name: string; x: number; y: number } | null>(null);
  const sortedRows = rows
    .filter((row) => mode === "costs" ? row.costUsd !== null && row.costUsd > 0 : true)
    .sort((a, b) => (mode === "costs" ? (b.costUsd ?? 0) - (a.costUsd ?? 0) : b.total - a.total));
  const chartRows = limit === "all" ? sortedRows : sortedRows.slice(0, Number(limit));
  const maxValue = chartRows.length > 0
    ? Math.max(...chartRows.map((row) => mode === "costs" ? row.costUsd ?? 0 : row.total), 1)
    : 1;
  const hoveredDetails = chartRows.find((row) => row.name === hoveredRow?.name) ?? null;
  const axisTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({ ratio, value: maxValue * ratio }));
  const positionTooltip = (name: string, x: number, y: number) => {
    const tooltipWidth = Math.min(290, Math.max(0, window.innerWidth - 32));
    const tooltipHeight = 128;
    const maxX = Math.max(8, window.innerWidth - tooltipWidth - 8);
    const maxY = Math.max(8, window.innerHeight - tooltipHeight - 8);
    const left = Math.min(x + 14, maxX);
    const top = y + 14 <= maxY ? y + 14 : Math.max(8, y - tooltipHeight - 14);
    setHoveredRow({ name, x: Math.max(8, left), y: Math.max(8, top) });
  };

  return (
    <div className="relative mb-3 rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-2)]">{mode === "costs" ? "Estimated cost share" : `Usage by ${dimension}`}</div>
          <div className="mt-0.5 text-[10px] text-[var(--text-3)]">
            Showing {chartRows.length === sortedRows.length ? "all" : chartRows.length} of {sortedRows.length} · scale uses {mode === "costs" ? "USD" : "K / M / B"} · hover a bar for details
          </div>
        </div>
        <Badge tone={mode === "costs" ? "warn" : "info"}>{mode === "costs" ? "USD" : "tokens"}</Badge>
      </div>
      {chartRows.length === 0 ? (
        <div className="grid min-h-[180px] place-items-center text-center text-xs text-[var(--text-3)]">{mode === "costs" ? "No priced usage for this period." : "No usage for this period."}</div>
      ) : (
        <>
          <div className="space-y-2.5">
            {chartRows.map((row) => {
              const displayName = dimension === "provider" ? providerDisplayName(row.name, providerNames) : row.name;
              const value = mode === "costs" ? row.costUsd ?? 0 : row.total;
              const width = value > 0 ? `${Math.max(2, (value / maxValue) * 100)}%` : "0%";
              const cachedWidth = row.cached > 0 ? `${Math.max(1, (row.cached / maxValue) * 100)}%` : "0%";
              const tooltip = `${displayName} · ${mode === "costs" ? `estimated cost ${formatUsd(row.costUsd)}` : `total ${formatTokens(row.total)}`}`;
              return (
                <div
                  key={row.name}
                  className="group relative"
                  onMouseEnter={(event) => positionTooltip(row.name, event.clientX, event.clientY)}
                  onMouseMove={(event) => positionTooltip(row.name, event.clientX, event.clientY)}
                  onMouseLeave={() => setHoveredRow(null)}
                  onFocus={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    positionTooltip(row.name, rect.right, rect.top);
                  }}
                  onBlur={() => setHoveredRow(null)}
                >
                  <div className="mb-1 flex items-center justify-between gap-2 text-[10px]">
                    <span className="min-w-0 truncate font-mono font-semibold text-[var(--text-2)]" title={displayName}>{displayName}</span>
                    <span className="shrink-0 font-semibold tabular-nums text-[var(--text-1)]">{mode === "costs" ? formatUsd(row.costUsd) : formatTokens(row.total)}</span>
                  </div>
                  <div
                    className="relative h-4 overflow-hidden rounded-full bg-[var(--surface-muted)] ring-1 ring-inset ring-[var(--inner-border)]"
                    title={tooltip}
                    role="img"
                    aria-label={tooltip}
                  >
                    <div className={`absolute inset-y-0 left-0 rounded-full ${mode === "costs" ? "bg-[#ffd60a]" : "bg-[var(--accent)]"}`} style={{ width, backgroundColor: mode === "costs" ? "#ffd60a" : "var(--accent)" }} />
                    {mode === "tokens" && row.cached > 0 && <div className="absolute inset-y-0 left-0 rounded-full bg-[#bf5af2]" style={{ width: cachedWidth, backgroundColor: "#bf5af2" }} />}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex items-center gap-3 text-[10px] text-[var(--text-3)]">
            <span className="inline-flex items-center gap-1"><i className="size-2 rounded-full bg-[var(--accent)]" />Total usage</span>
            {mode === "tokens" && <span className="inline-flex items-center gap-1"><i className="size-2 rounded-full bg-[#bf5af2]" />Cached</span>}
          </div>
          <div className="relative mt-3 h-6 border-t border-[var(--inner-border)]">
            {axisTicks.map(({ ratio, value }) => (
              <span
                key={ratio}
                className={`absolute top-1 text-[9px] tabular-nums text-[var(--text-3)] ${ratio === 0 ? "" : ratio === 1 ? "-translate-x-full" : "-translate-x-1/2"}`}
                style={{ left: `${ratio * 100}%` }}
              >
                {formatUsageScale(value, maxValue, mode)}
              </span>
            ))}
          </div>
        </>
      )}
      {hoveredDetails && hoveredRow && createPortal(
        <div
          role="tooltip"
          className="pointer-events-none fixed z-50 max-w-[min(290px,calc(100vw-2rem))] rounded-lg border border-[var(--glass-border-2)] bg-[var(--popover-bg)] px-3 py-2 text-[10px] shadow-xl"
          style={{ left: hoveredRow.x, top: hoveredRow.y }}
        >
          <div className="truncate font-mono font-semibold text-[var(--text-1)]">{dimension === "provider" ? providerDisplayName(hoveredDetails.name, providerNames) : hoveredDetails.name}</div>
          <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[var(--text-2)]">
            <span>Requests <strong className="text-[var(--text-1)]">{formatNumber(hoveredDetails.requests)}</strong></span>
            <span>Errors <strong className="text-[var(--text-1)]">{formatNumber(hoveredDetails.errors)}</strong></span>
            <span>Input <strong className="text-[var(--text-1)]">{formatTokens(hoveredDetails.input)}</strong></span>
            <span>Cached <strong className="text-[#bf5af2]">{formatTokens(hoveredDetails.cached)}</strong></span>
            <span>Output <strong className="text-[var(--text-1)]">{formatTokens(hoveredDetails.output)}</strong></span>
            <span>{mode === "costs" ? "Cost" : "Total"} <strong className="text-[var(--text-1)]">{mode === "costs" ? formatUsd(hoveredDetails.costUsd) : formatTokens(hoveredDetails.total)}</strong></span>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

function BreakdownCard({ period, dimension, onDimensionChange }: { period: Period; dimension: Dimension; onDimensionChange: (value: string) => void }) {
  const providerNames = useProviderNames();
  const [mode, setMode] = useState<BreakdownMetric>("tokens");
  const [limit, setLimit] = useState<BreakdownLimit>("5");
  const byQuery = useUsageResource<{ rows: ByRow[] }>(qk.usage.by(period, dimension), `/usage/by-${dimension}?period=${period}`);
  const cacheQuery = useUsageResource<CacheSummary & { period: Period }>(qk.usage.cache(period), `/usage/cache?period=${period}`, { refetchInterval: 10_000 });
  const rows = byQuery.data?.rows ?? [];
  const cache = cacheQuery.data;
  const modeIsCosts = mode === "costs";

  return (
    <Card className="min-w-0" density="compact">
      <CardHeader title="Usage breakdown" icon={Database} iconColor="#bf5af2" sub="Cache usage, tokens, and cost share one analytics surface.">
        <div className="flex w-full flex-wrap items-center justify-between gap-1.5 sm:w-auto">
          <Tabs tabs={[{ id: "tokens", label: "Tokens" }, { id: "costs", label: "Costs" }]} value={mode} onChange={(value) => setMode(value as BreakdownMetric)} />
          <Select ariaLabel="Breakdown dimension" value={dimension} onChange={onDimensionChange} options={[{ value: "model", label: "Usage by model" }, { value: "provider", label: "Usage by provider" }, { value: "key", label: "Usage by API key" }]} />
          <Select ariaLabel="Breakdown limit" value={limit} onChange={(value) => setLimit(value as BreakdownLimit)} options={[{ value: "5", label: "Top 5" }, { value: "10", label: "Top 10" }, { value: "all", label: "All" }]} />
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
      {!byQuery.isLoading && <BreakdownBarChart rows={rows} dimension={dimension} mode={mode} limit={limit} providerNames={providerNames} />}
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
  const summaryQuery = useUsageResource<SummaryResponse>(qk.usage.summary(period), `/usage/summary?period=${period}`, { refetchInterval: 10_000 });
  const summary = summaryQuery.data?.totals;
  const requestsQuery = useUsageResource<{ items: RequestRow[] }>(qk.usage.recentRequests, "/usage/requests?limit=10", { refetchInterval: 5_000 });
  const requestItems = (requestsQuery.data?.items ?? []).filter((r) => r.statusCode > 0);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    next.set(key, value);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="dashboard-page space-y-4">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        {STAT_CARDS.map((card) => (
          <div key={card.key} className="glass min-w-0 rounded-[var(--radius-card)] p-3.5 transition-transform duration-200 hover:-translate-y-0.5">
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
        <CardHeader title="Requests" icon={Activity} sub="Newest first · 10 visible · scroll to browse request history">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[rgba(48,209,88,0.14)] px-2.5 py-1 text-[11px] font-semibold text-[#1fa84a] dark:text-[var(--green)]">
            <Radio size={11} className="animate-pulse" />
            Live
          </span>
        </CardHeader>

        <div className="max-h-[445px] overflow-auto overscroll-contain rounded-xl border border-[var(--inner-border)]">
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
