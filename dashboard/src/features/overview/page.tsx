import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  Activity,
  Cpu,
  Database,
  Gauge,
  Globe,
  MemoryStick,
  Network,
  TriangleAlert,
} from "lucide-react";
import { apiGet } from "../../lib/api";
import { formatBandwidthKb, formatDuration, formatMemoryMb } from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { ClipboardButton } from "../../components/patterns/clipboard-button";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardHeader } from "../../components/ui/card";
import { StatCard, StatePanel } from "../../components/ui/state";
import { ApiKeysPanel } from "./api-keys-panel";

interface ProviderOverview {
  id: string;
  prefix: string;
  status: "ok" | "warn";
  requestsToday: number;
  input: number;
  cached: number;
  output: number;
  errors: number;
  lastError: string | null;
}

interface OverviewData {
  totals: {
    requests: number;
    inputTokens: number;
    cachedTokens: number;
    outputTokens: number;
    errors: number;
    avgDurationMs: number;
    estimatedCostUsd: number;
  };
  providers: ProviderOverview[];
  registered: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Validates and normalizes the current console overview response shape. */
export function parseOverviewData(value: unknown): OverviewData | null {
  if (!isRecord(value) || !Array.isArray(value.registered) || !value.registered.every((item) => typeof item === "string") || !Array.isArray(value.providers) || !isRecord(value.totals)) return null;
  const totals = value.totals;
  const totalKeys: (keyof OverviewData["totals"])[] = ["requests", "inputTokens", "cachedTokens", "outputTokens", "errors"];
  if (!totalKeys.every((key) => isFiniteNumber(totals[key]))) return null;
  const requests = totals.requests;
  const inputTokens = totals.inputTokens;
  const cachedTokens = totals.cachedTokens;
  const outputTokens = totals.outputTokens;
  const errors = totals.errors;
  const avgDurationMs = isFiniteNumber(totals.avgDurationMs) ? totals.avgDurationMs : 0;
  const estimatedCostUsd = isFiniteNumber(totals.estimatedCostUsd) ? totals.estimatedCostUsd : 0;
  if (!isFiniteNumber(requests) || !isFiniteNumber(inputTokens) || !isFiniteNumber(cachedTokens) || !isFiniteNumber(outputTokens) || !isFiniteNumber(errors)) return null;
  const providers: ProviderOverview[] = [];
  for (const item of value.providers) {
    if (!isRecord(item) || typeof item.providerId !== "string" || !isFiniteNumber(item.requests) || !isFiniteNumber(item.inputTokens) || !isFiniteNumber(item.cachedTokens) || !isFiniteNumber(item.outputTokens) || !isFiniteNumber(item.errors)) return null;
    providers.push({ id: item.providerId, prefix: item.providerId, status: item.errors > 0 ? "warn" : "ok", requestsToday: item.requests, input: item.inputTokens, cached: item.cachedTokens, output: item.outputTokens, errors: item.errors, lastError: null });
  }
  return {
    totals: {
      requests,
      inputTokens,
      cachedTokens,
      outputTokens,
      errors,
      avgDurationMs,
      estimatedCostUsd,
    },
    providers,
    registered: value.registered,
  };
}


interface HealthMetrics {
  memoryUsedMb: number;
  memorySystemUsedMb: number;
  memoryTotalMb: number;
  cpuPercent: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  coreCount: number;
  cpuModel: string;
  pid: number;
  netReceivedKb: number | null;
  netSentKb: number | null;
  netTotalKb: number | null;
  netRateKbps: number | null;
}

interface WarpMetricsSummary {
  totalRssMb: number;
  totalRxMb: number;
  totalTxMb: number;
  totalBandwidthMb: number;
  runningCount: number;
  healthyCount: number;
}





export function OverviewPage() {
  const baseUrl = useMemo(() => `${window.location.origin}/v1`, []);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: qk.overview.all,
    queryFn: async () => {
      const response = await apiGet<unknown>("/overview");
      const parsed = parseOverviewData(response);
      if (parsed === null) throw new Error("Invalid overview response");
      return parsed;
    },
  });


  const healthQuery = useQuery({
    queryKey: qk.health.metrics,
    queryFn: () => apiGet<HealthMetrics>("/health/metrics"),
    refetchInterval: 5_000,
  });

  const warpMetricsQuery = useQuery({
    queryKey: qk.warp.metricsSummary,
    queryFn: () => apiGet<WarpMetricsSummary>("/warp/metrics/summary"),
    refetchInterval: 5_000,
  });



  if (isLoading) return <StatePanel kind="loading" title="Loading overview" description="Collecting runtime and provider health data…" />;
  if (isError || !data) return <StatePanel kind="error" title="Failed to load overview" description="The overview response was unavailable or invalid." action={<Button variant="secondary" onClick={() => refetch()}>Retry</Button>} />;

  const { totals } = data;
  const errorRate = totals.requests > 0 ? ((totals.errors / totals.requests) * 100).toFixed(1) : "0.0";
  const cacheRate = totals.inputTokens > 0 ? Math.round((totals.cachedTokens / totals.inputTokens) * 100) : 0;
  const health = healthQuery.data;
  const cpuPercent = health ? Math.min(100, Math.max(0, health.cpuPercent)) : 0;
  const ramSystemPercent = health && health.memoryTotalMb > 0 ? Math.min(100, Math.max(0, (health.memorySystemUsedMb / health.memoryTotalMb) * 100)) : 0;


  return (
    <div className="dashboard-page space-y-4">
      <Card surface="base" className="health-card endpoint-card">
        <CardHeader title="API Endpoint" icon={Globe} sub="Base URL for OpenAI- and Anthropic-compatible clients" />
        <div className="health-card-resource min-w-0 rounded-[14px] p-4 lg:p-5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--text-3)]">Primary endpoint</span>
            <Badge tone="default">Local</Badge>
          </div>
          <code className="mt-3 block overflow-x-auto rounded-[var(--radius-control)] bg-[var(--kbd-bg)] px-3 py-2.5 font-mono text-[13px] font-semibold text-[var(--text-1)]" title={baseUrl}>{baseUrl}</code>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] text-[var(--text-2)]">
            <span>OpenAI &amp; Anthropic compatible</span>
            <span className="text-[var(--text-3)]">·</span>
            <span>Copy-ready for clients</span>
            <ClipboardButton value={baseUrl} variant="ghost" size="sm" className="ml-auto h-7 px-2 text-[10px]" />
          </div>
        </div>
      </Card>


      <Card surface="base" className="health-card">

        <CardHeader title="Health" icon={Gauge} iconColor="#30d158" sub="Last 24 hours · runtime resource usage" />
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <StatCard className="health-stat-card" label="Latency" icon={Activity} tone="info" value={formatDuration(totals.avgDurationMs)} description="Avg duration" />
          <StatCard className="health-stat-card" label="Cache" icon={Database} tone="accent" value={`${cacheRate}%`} description="Cache rate" />
          <StatCard className="health-stat-card" label="Errors" icon={TriangleAlert} tone="danger" value={`${errorRate}%`} description="Error rate" />
          <StatCard className="health-stat-card" label="Registry" icon={Globe} tone="success" value={data.registered.length} description="Providers" />

          <div className="health-resource-grid col-span-2 grid grid-cols-1 gap-2.5 sm:col-span-4">
            <section aria-labelledby="health-ram-title" className="health-card-resource flex min-w-0 flex-col rounded-[14px] p-3 transition-colors">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-[rgba(191,90,242,0.13)] text-[#bf5af2]"><MemoryStick size={14} /></span>
                  <div className="min-w-0">
                    <h3 id="health-ram-title" className="whitespace-nowrap text-xs font-bold tracking-tight">RAM usage</h3>
                    <p className="mt-0.5 line-clamp-2 text-[9.5px] leading-[1.25] text-[var(--text-3)]">Bun Runtime · Cartethyia process</p>
                </div>
                </div>
              </div>
              <div className="mt-3 flex min-w-0 items-baseline gap-2">
                <span className="min-w-0 truncate text-[22px] font-bold leading-none tracking-tight tabular-nums">{health ? formatMemoryMb(health.memoryUsedMb) : "—"}</span>
                <span className="shrink-0 text-[9.5px] text-[var(--text-3)]">RSS</span>
              </div>
              <Badge tone="accent" className="mt-2 max-w-full whitespace-normal break-words">{health ? `${formatMemoryMb(health.memorySystemUsedMb)} system` : "—"}</Badge>
              <p className="mt-2 text-[9.5px] leading-[1.35] text-[var(--text-3)]">RSS is the whole Cartethyia process — Bun runtime, native/JIT overhead, JS heap, and buffers combined.</p>
              <div className="mt-3 h-1 overflow-hidden rounded-full bg-[var(--track)]" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={health ? ramSystemPercent : 0}>
                <div className="h-full origin-left rounded-full bg-[#bf5af2] transition-transform duration-500" style={{ transform: `scaleX(${ramSystemPercent / 100})` }} />
              </div>
              {health && (() => {
                const nativeMb = Math.max(0, health.memoryUsedMb - health.heapTotalMb - health.externalMb - health.arrayBuffersMb);
                const rss = health.memoryUsedMb;
                return (
                  <div className="mt-auto grid grid-cols-2 gap-x-3 gap-y-2 pt-3">
                    {([
                      { label: "JS heap", used: health.heapUsedMb, bar: health.heapTotalMb, color: "#bf5af2" },
                      { label: "Bun runtime", used: nativeMb, bar: nativeMb, color: "#30d158" },
                      { label: "External", used: health.externalMb, bar: health.externalMb, color: "#ff9f0a" },
                      { label: "Array buffers", used: health.arrayBuffersMb, bar: health.arrayBuffersMb, color: "#0a84ff" },
                    ] as const).map(({ label, used, bar, color }) => (
                      <div key={label}>
                        <div className="mb-0.5 flex justify-between text-[9px] text-[var(--text-3)]">
                          <span>{label}</span>
                          <span className="tabular-nums">{formatMemoryMb(used)}</span>
                        </div>
                        <div className="h-0.5 overflow-hidden rounded-full bg-[var(--track)]">
                          <div className="h-full origin-left rounded-full transition-transform duration-500" style={{ transform: `scaleX(${Math.min(1, Math.max(0, rss === 0 ? 0 : bar / rss))})`, background: color }} />
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </section>

            <section aria-labelledby="health-warp-title" className="health-card-resource flex min-w-0 flex-col rounded-[14px] p-3 transition-colors">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-[rgba(48,209,88,0.14)] text-[#30d158]"><Globe size={14} /></span>
                  <div className="min-w-0">
                    <h3 id="health-warp-title" className="whitespace-nowrap text-xs font-bold tracking-tight">Warp Proxy</h3>
                    <p className="mt-0.5 line-clamp-2 text-[9.5px] leading-[1.25] text-[var(--text-3)]">MultiWarp pool · wireproxy instances</p>
                  </div>
                </div>
              </div>
              <div className="mt-3 flex min-w-0 items-baseline gap-2">
                <span className="min-w-0 truncate text-[22px] font-bold leading-none tracking-tight tabular-nums">{warpMetricsQuery.data ? formatMemoryMb(warpMetricsQuery.data.totalRssMb) : "—"}</span>
                <span className="shrink-0 text-[9.5px] text-[var(--text-3)]">RSS</span>
              </div>
              <Badge tone="accent" className="mt-2 max-w-full whitespace-normal break-words">{warpMetricsQuery.data ? `${warpMetricsQuery.data.runningCount} running` : "—"}</Badge>
              <p className="mt-2 text-[9.5px] leading-[1.35] text-[var(--text-3)]">Per-instance RSS summed across all running wireproxy processes. ~20–40 MB per instance.</p>
              <div className="mt-auto grid grid-cols-2 gap-2.5 pt-3">
                <div>
                  <div className="mb-0.5 flex justify-between text-[9px] text-[var(--text-3)]">
                    <span>Healthy</span>
                    <span className="tabular-nums">{warpMetricsQuery.data?.healthyCount ?? "—"}</span>
                  </div>
                  <div className="h-0.5 overflow-hidden rounded-full bg-[var(--track)]">
                    <div className="h-full origin-left rounded-full bg-[#30d158] transition-transform duration-500" style={{ transform: `scaleX(${warpMetricsQuery.data && warpMetricsQuery.data.runningCount > 0 ? Math.min(1, warpMetricsQuery.data.healthyCount / warpMetricsQuery.data.runningCount) : 0})` }} />
                  </div>
                </div>
                <div>
                  <div className="mb-0.5 flex justify-between text-[9px] text-[var(--text-3)]">
                    <span>Bandwidth</span>
                    <span className="tabular-nums">{warpMetricsQuery.data ? `${warpMetricsQuery.data.totalBandwidthMb} MB` : "—"}</span>
                  </div>
                  <div className="h-0.5 overflow-hidden rounded-full bg-[var(--track)]">
                    <div className="h-full origin-left rounded-full bg-[#0a84ff] transition-transform duration-500" style={{ transform: `scaleX(${warpMetricsQuery.data && warpMetricsQuery.data.totalBandwidthMb > 0 ? Math.min(1, warpMetricsQuery.data.totalBandwidthMb / 100) : 0})` }} />
                  </div>
                </div>
              </div>
            </section>

            <section aria-labelledby="health-net-title" className="health-card-resource flex min-w-0 flex-col rounded-[14px] p-3 transition-colors">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-[rgba(10,132,255,0.13)] text-[#0a84ff]"><Network size={14} /></span>
                  <div className="min-w-0">
                    <h3 id="health-net-title" className="whitespace-nowrap text-xs font-bold tracking-tight">Network</h3>
                    <p className="mt-0.5 line-clamp-2 text-[9.5px] leading-[1.25] text-[var(--text-3)]">VPS bandwidth · all interfaces</p>
                  </div>
                </div>
              </div>
              <div className="mt-3 flex items-end justify-between gap-2.5">
                <div className="flex items-baseline gap-2">
                  <span className="shrink-0 whitespace-nowrap text-[22px] font-bold leading-none tracking-tight tabular-nums">{health ? formatBandwidthKb(health.netTotalKb) : "—"}</span>
                  <span className="text-[9.5px] text-[var(--text-3)]">total</span>
                </div>
                <Badge tone="default" className="whitespace-nowrap">{health?.netRateKbps != null ? `${health.netRateKbps.toLocaleString("en-US")} KB/s` : "—"}</Badge>
              </div>
              <p className="mt-2 text-[9.5px] leading-[1.35] text-[var(--text-3)]">Cumulative network I/O across all interfaces since boot. Rate is sampled every 5s.</p>
              <div className="mt-auto grid grid-cols-2 gap-2.5 pt-3">
                <div>
                  <div className="mb-0.5 flex justify-between text-[9px] text-[var(--text-3)]">
                    <span>Received</span>
                    <span className="tabular-nums">{health ? formatBandwidthKb(health.netReceivedKb) : "—"}</span>
                  </div>
                  <div className="h-0.5 overflow-hidden rounded-full bg-[var(--track)]">
                    <div className="h-full origin-left rounded-full bg-[#0a84ff] transition-transform duration-500" style={{ transform: `scaleX(${health && health.netTotalKb && health.netReceivedKb ? Math.min(1, health.netReceivedKb / health.netTotalKb) : 0})` }} />
                  </div>
                </div>
                <div>
                  <div className="mb-0.5 flex justify-between text-[9px] text-[var(--text-3)]">
                    <span>Sent</span>
                    <span className="tabular-nums">{health ? formatBandwidthKb(health.netSentKb) : "—"}</span>
                  </div>
                  <div className="h-0.5 overflow-hidden rounded-full bg-[var(--track)]">
                    <div className="h-full origin-left rounded-full bg-[#30d158] transition-transform duration-500" style={{ transform: `scaleX(${health && health.netTotalKb && health.netSentKb ? Math.min(1, health.netSentKb / health.netTotalKb) : 0})` }} />
                  </div>
                </div>
              </div>
            </section>

            <section aria-labelledby="health-cpu-title" className="health-card-resource flex min-w-0 flex-col rounded-[14px] p-3 transition-colors">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-[rgba(255,159,10,0.14)] text-[#ff9f0a]"><Cpu size={14} /></span>
                  <div className="min-w-0">
                    <h3 id="health-cpu-title" className="whitespace-nowrap text-xs font-bold tracking-tight">CPU usage</h3>
                    <p className="mt-0.5 line-clamp-2 text-[9.5px] leading-[1.25] text-[var(--text-3)]">Current process load</p>
                  </div>
                </div>
              </div>
              <div className="mt-3 flex items-center gap-3">
                <div className="relative grid size-[72px] shrink-0 place-items-center rounded-full" style={{ background: `conic-gradient(#ff9f0a ${cpuPercent}%, var(--track) 0)` }} role="img" aria-label={health ? `CPU usage ${cpuPercent.toFixed(1)} percent` : "CPU usage unavailable"}>
                  <div className="grid size-[56px] place-items-center rounded-full health-card-inset">
                    <span className="text-[15px] font-bold tabular-nums">{health ? `${cpuPercent.toFixed(1)}%` : "—"}</span>
                  </div>
                </div>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex items-center justify-between gap-2 rounded-lg health-card-inset px-2 py-2 text-[9.5px]">
                    <span className="text-[var(--text-3)]">Cores</span>
                    <span className="font-semibold tabular-nums">{health ? `${health.coreCount} logical` : "—"}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2 rounded-lg health-card-inset px-2 py-2 text-[9.5px]">
                    <span className="text-[var(--text-3)]">PID</span>
                    <span className="max-w-[7rem] truncate font-mono font-semibold">{health ? String(health.pid) : "—"}</span>
                  </div>
                </div>
              </div>
              {health && <div className="mt-auto truncate pt-3 text-[9px] text-[var(--text-3)]" title={health.cpuModel}>{health.cpuModel}</div>}
            </section>
          </div>
        </div>
      </Card>
      <ApiKeysPanel />

    </div>
  );
}
