import { useMemo } from "react";

import { Activity, AlertTriangle, Clock3, Database, Globe, Server, ShieldAlert } from "lucide-react";

import { ClipboardButton } from "../../components/patterns/clipboard-button";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardHeader } from "../../components/ui/card";
import { StatCard, StatePanel } from "../../components/ui/state";
import type { DashboardSummary } from "../../lib/daemon-api";
import { useDashboardHealth, type DashboardHealthState, type DashboardSummaryView, type DashboardViewState } from "./health";

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
    requests: number | null;
    inputTokens: number | null;
    cachedTokens: number | null;
    outputTokens: number | null;
    errors: number | null;
    avgDurationMs: number | null;
    estimatedCostUsd: number | null;
  };
  providers: ProviderOverview[];
  registered: string[];
  daemon?: DashboardSummary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Validates and normalizes the legacy telemetry shape retained by focused parser tests. */
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
    totals: { requests, inputTokens, cachedTokens, outputTokens, errors, avgDurationMs, estimatedCostUsd },
    providers,
    registered: value.registered,
  };
}

function countLabel(value: number | null): string {
  return value === null ? "Unknown" : value.toLocaleString("en-US");
}

function stateTitle(state: DashboardViewState): string {
  if (state === "degraded") return "Dashboard data degraded";
  if (state === "offline") return "Daemon is offline";
  if (state === "forbidden") return "Dashboard access forbidden";
  if (state === "unavailable") return "Dashboard health unavailable";
  if (state === "malformed") return "Invalid dashboard response";
  if (state === "empty") return "Dashboard returned no data";
  if (state === "unknown") return "Dashboard health unknown";
  return "Dashboard health";
}

function stateDescription(state: DashboardViewState, hasLastSafeResponse: boolean): string {
  if (state === "degraded") return hasLastSafeResponse ? "Showing the last safe response while one or more daemon dependencies are degraded." : "The daemon reported degraded health; readiness is not guaranteed.";
  if (state === "offline") return hasLastSafeResponse ? "The daemon could not be reached. Values below are stale and may no longer be current." : "The daemon could not be reached. Retry when the service is available.";
  if (state === "forbidden") return "The current session is not authorized to read dashboard health.";
  if (state === "unavailable") return "This dashboard capability is not available from the daemon.";
  if (state === "malformed") return "The daemon response did not match the dashboard contract. No values from it were rendered.";
  if (state === "empty") return "The daemon returned an empty response. No healthy defaults were substituted.";
  if (state === "unknown") return "The daemon did not provide enough health evidence to determine readiness.";
  return "Live status from this Cartethyia instance.";
}


function healthLabel(state: DashboardHealthState): string {
  if (state === "ready") return "Ready";
  if (state === "degraded") return "Degraded";
  if (state === "offline") return "Offline";
  return "Unknown";
}

function healthTone(state: DashboardHealthState): "ok" | "warn" | "err" | "default" {
  if (state === "ready") return "ok";
  if (state === "degraded") return "warn";
  if (state === "offline") return "err";
  return "default";
}


function SummaryCards({ data }: { data: DashboardSummaryView }) {
  const health = data.health;
  const dependencyEntries = Object.entries(health.dependencies);
  return (
    <>
      <Card surface="base" className="health-card">
        <CardHeader title="Daemon summary" icon={Server} sub="Facts reported by /v2/admin/dashboard" />
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard label="Version" icon={Activity} tone="info" value={data.version ?? "Unknown"} description="Daemon version" />
          <StatCard label="Environment" icon={Globe} tone="neutral" value={data.environment ?? "Unknown"} description="Reported environment" />
          <StatCard label="Uptime" icon={Clock3} tone="neutral" value={data.uptime ?? "Unknown"} description="Reported uptime" />
          <StatCard label="Accounts" icon={Globe} tone="success" value={countLabel(data.accountCount)} description="Configured accounts" />
          <StatCard label="Proxies" icon={Globe} tone="info" value={countLabel(data.proxyCount)} description="Configured proxies" />
          <StatCard label="API keys" icon={ShieldAlert} tone="neutral" value={countLabel(data.apiKeyCount)} description="Configured keys" />
        </div>
      </Card>

      <Card surface="base" className="health-card">
        <CardHeader title="Dependency health" icon={Database} sub="Readiness is shown only when supplied by the daemon" />
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={healthTone(health.status)}>{healthLabel(health.status)} overall</Badge>
          {dependencyEntries.length === 0 ? (
            <span className="text-xs text-[var(--text-2)]">No dependency health reported · Unknown</span>
          ) : (
            dependencyEntries.map(([name, state]) => <Badge key={name} tone={healthTone(state)}>{name}: {healthLabel(state)}</Badge>)
          )}
        </div>
      </Card>
    </>
  );
}

export function OverviewPage() {
  const baseUrl = useMemo(() => `${window.location.origin}/v1`, []);
  const health = useDashboardHealth();
  if (health.isLoading) return <StatePanel kind="loading" title="Loading overview" description="Collecting daemon health…" />;
  if (!health.data && health.state !== "ready" && health.state !== "unknown") {
    const kind = health.state === "empty" ? "empty" : health.state === "degraded" ? "degraded" : "error";
    return <StatePanel kind={kind} title={stateTitle(health.state)} description={stateDescription(health.state, false)} action={<Button variant="secondary" onClick={() => void health.refetch()}>Retry</Button>} />;
  }
  if (!health.data) return <StatePanel kind="degraded" title="Dashboard health unknown" description={stateDescription("unknown", false)} action={<Button variant="secondary" onClick={() => void health.refetch()}>Retry</Button>} />;

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

      <SummaryCards data={health.data} />

      <Card surface="base" className="health-card">
        <CardHeader title="Readiness note" icon={AlertTriangle} sub="The console does not infer provider or dependency readiness from counts" />
        <p className="text-xs leading-relaxed text-[var(--text-2)]">{health.isStale ? "This view contains a previously accepted response. Treat values as stale until the next refresh succeeds." : health.state === "ready" ? "The daemon reported a ready overall state. Individual dependencies remain authoritative below." : "The daemon has not supplied enough evidence to claim readiness."}</p>
        {health.isRefreshing && <p className="mt-2 text-xs font-semibold text-[var(--accent)]" role="status">Refreshing dashboard health…</p>}
      </Card>
    </div>
  );
}
