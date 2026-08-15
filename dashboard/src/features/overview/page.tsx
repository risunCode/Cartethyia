/* @jsxImportSource solid-js */

import { Activity, AlertTriangle, Database, Globe, Server } from "lucide-solid";
import { For, Show, type JSX } from "solid-js";

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
  return { totals: { requests, inputTokens, cachedTokens, outputTokens, errors, avgDurationMs, estimatedCostUsd }, providers, registered: value.registered };
}

function countLabel(value: number | null): string {
  return value === null ? "Unknown" : value.toLocaleString("en-US");
}

function stateTitle(state: DashboardViewState): string {
  if (state === "degraded") return "Dashboard data degraded";
  if (state === "offline") return "Gateway is offline";
  if (state === "forbidden") return "Dashboard access forbidden";
  if (state === "unavailable") return "Dashboard health unavailable";
  if (state === "malformed") return "Invalid dashboard response";
  if (state === "empty") return "Dashboard returned no data";
  if (state === "unknown") return "Dashboard health unknown";
  return "Dashboard health";
}

function stateDescription(state: DashboardViewState, hasLastSafeResponse: boolean): string {
  if (state === "degraded") return hasLastSafeResponse ? "Showing the last safe response while one or more dependencies are degraded." : "The gateway reported degraded health; readiness is not guaranteed.";
  if (state === "offline") return hasLastSafeResponse ? "The gateway could not be reached. Values below may be stale." : "The gateway could not be reached. Retry when the service is available.";
  if (state === "forbidden") return "The current session is not authorized to read dashboard health.";
  if (state === "unavailable") return "This dashboard capability is not available.";
  if (state === "malformed") return "The response did not match the dashboard contract.";
  if (state === "empty") return "The gateway returned an empty response.";
  if (state === "unknown") return "The gateway did not provide enough health evidence to determine readiness.";
  return "Live status from this Cartethyia instance.";
}

function healthLabel(state: DashboardHealthState): string {
  if (state === "ready") return "Ready";
  if (state === "degraded") return "Degraded";
  if (state === "offline") return "Offline";
  return "Unknown";
}

function healthTone(state: DashboardHealthState): string {
  if (state === "ready") return "text-[var(--green)]";
  if (state === "degraded") return "text-[var(--yellow)]";
  if (state === "offline") return "text-[var(--red)]";
  return "text-[var(--text-2)]";
}

function Stat({ label, value, description }: { label: string; value: string; description: string }) {
  return <div class="rounded-[14px] border border-[var(--inner-border)] bg-[var(--surface-muted)] p-3"><div class="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-3)]">{label}</div><div class="mt-1 truncate text-sm font-semibold text-[var(--text-1)]">{value}</div><div class="mt-1 text-[10px] text-[var(--text-2)]">{description}</div></div>;
}

function SummaryCards(props: { data: DashboardSummaryView }) {
  const dependencyEntries = Object.entries(props.data.health.dependencies);
  return <>
    <section class="health-card rounded-[18px] border border-[var(--inner-border)] bg-[var(--surface)] p-4">
      <div class="mb-3 flex items-center gap-2"><Server size={16} aria-hidden="true" /><div><h2 class="text-sm font-semibold">Gateway summary</h2><p class="text-[11px] text-[var(--text-2)]">Facts reported by the console API</p></div></div>
      <div class="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6"><Stat label="Version" value={props.data.version ?? "Unknown"} description="Gateway version" /><Stat label="Environment" value={props.data.environment ?? "Unknown"} description="Reported environment" /><Stat label="Uptime" value={props.data.uptime ?? "Unknown"} description="Reported uptime" /><Stat label="Accounts" value={countLabel(props.data.accountCount)} description="Configured accounts" /><Stat label="Proxies" value={countLabel(props.data.proxyCount)} description="Configured proxies" /><Stat label="API keys" value={countLabel(props.data.apiKeyCount)} description="Configured keys" /></div>
    </section>
    <section class="health-card rounded-[18px] border border-[var(--inner-border)] bg-[var(--surface)] p-4"><div class="mb-3 flex items-center gap-2"><Database size={16} aria-hidden="true" /><div><h2 class="text-sm font-semibold">Dependency health</h2><p class="text-[11px] text-[var(--text-2)]">Readiness supplied by the gateway</p></div></div><div class="flex flex-wrap gap-2"><span class={`text-xs font-semibold ${healthTone(props.data.health.status)}`}>{healthLabel(props.data.health.status)} overall</span><For each={dependencyEntries}>{([name, state]) => <span class={`text-xs ${healthTone(state)}`}>{name}: {healthLabel(state)}</span>}</For></div></section>
  </>;
}

export function OverviewPage() {
  const baseUrl = `${window.location.origin}/v1`;
  const health = useDashboardHealth();
  return <div class="dashboard-page overview-page space-y-4">
    <Show when={!health.isLoading} fallback={<StatePanel title="Loading overview" description="Collecting gateway health…" />}>
      <Show when={health.data} fallback={<StatePanel title={stateTitle(health.state)} description={stateDescription(health.state, false)} action={<button type="button" onClick={() => void health.refetch()} class="rounded-[var(--radius-control)] border border-[var(--inner-border)] px-3 py-2 text-xs font-semibold">Retry</button>} />}>
        {(data) => <>
          <section class="health-card rounded-[18px] border border-[var(--inner-border)] bg-[var(--surface)] p-4"><div class="mb-3 flex items-center gap-2"><Globe size={16} aria-hidden="true" /><div><h2 class="text-sm font-semibold">API Endpoint</h2><p class="text-[11px] text-[var(--text-2)]">Base URL for compatible clients</p></div></div><code class="block overflow-x-auto rounded-[var(--radius-control)] bg-[var(--kbd-bg)] px-3 py-2.5 font-mono text-[13px] font-semibold">{baseUrl}</code></section>
          <SummaryCards data={data()} />
          <section class="health-card rounded-[18px] border border-[var(--inner-border)] bg-[var(--surface)] p-4"><div class="mb-2 flex items-center gap-2"><AlertTriangle size={16} aria-hidden="true" /><h2 class="text-sm font-semibold">Readiness note</h2></div><p class="text-xs leading-relaxed text-[var(--text-2)]">{health.isStale ? "This view contains a previously accepted response. Treat values as stale until the next refresh succeeds." : health.state === "ready" ? "The gateway reported a ready overall state." : "The gateway has not supplied enough evidence to claim readiness."}</p><Show when={health.isRefreshing}><p class="mt-2 text-xs font-semibold text-[var(--accent)]" role="status">Refreshing dashboard health…</p></Show></section>
        </>}
      </Show>
    </Show>
  </div>;
}

function StatePanel(props: { title: string; description: string; action?: JSX.Element }) {
  return <section class="rounded-[18px] border border-[var(--inner-border)] bg-[var(--surface)] p-6"><div class="flex items-center gap-2"><Activity size={16} aria-hidden="true" /><h2 class="text-sm font-semibold">{props.title}</h2></div><p class="mt-2 text-xs text-[var(--text-2)]">{props.description}</p>{props.action}</section>;
}