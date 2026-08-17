import { Activity, Check, Copy, Globe, KeyRound, MemoryStick, Server, Timer, TriangleAlert } from "lucide-solid";
import { Show, createMemo, createResource, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { Card, CardHeader } from "@components/ui/card";
import { Button } from "@components/ui/button";
import { MetricCard } from "@components/shared/MetricCard";
import { StatePanel } from "@components/ui/state";
import type { IconTone } from "@components/ui/icon";
import { consoleGet, consoleCatalog, normalizeDashboardSummary, type CatalogProvider, type DashboardSummary } from "@lib/console-api";
import { toast } from "@lib/toast";

const SUMMARY_REFRESH_MS = 30_000;
const TELEMETRY_REFRESH_MS = 15_000;

type HealthTone = "ok" | "warn" | "err" | "neutral";

type SummaryResult = { ok: true; data: DashboardSummary } | { ok: false };

async function fetchSummary(): Promise<SummaryResult> {
  try {
    return { ok: true, data: normalizeDashboardSummary(await consoleGet<unknown>("/dashboard")) };
  } catch {
    return { ok: false };
  }
}

interface UsageSummary {
  requests: number | null;
  errors: number | null;
  avgDurationMs: number | null;
}

async function fetchUsageSummary(): Promise<UsageSummary> {
  try {
    const raw = await consoleGet<unknown>("/telemetry/usage?period=24h");
    if (typeof raw !== "object" || raw === null) return { requests: null, errors: null, avgDurationMs: null };
    const rec = raw as Record<string, unknown>;
    const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
    return {
      requests: num(rec["requests"]),
      errors: num(rec["errors"]),
      avgDurationMs: num(rec["avg_duration_ms"]) ?? num(rec["avgDurationMs"]),
    };
  } catch {
    return { requests: null, errors: null, avgDurationMs: null };
  }
}

const formatNumber = (n: number | null): string => (n === null ? "—" : n.toLocaleString("en-US"));

const formatDuration = (ms: number | null): string => {
  if (ms === null) return "—";
  if (ms < 1) return "<1 ms";
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  return `${(ms / 1_000).toFixed(2)} s`;
};

/** RAM usage will be sourced from the daemon's `/health/metrics` contract once
 * it is wired; until then the card shows an explicit "not available" state. */

/**
 * Overview — daemon health page. Endpoint info card + a System metrics card
 * with four stat tiles (Requests / Errors / Latency / Providers) and a wide
 * detail grid focused on overall RAM usage + Configuration counters. Wired
 * to /console/dashboard + /console/telemetry/usage + /console/catalog/providers.
 */
export default function Overview(): JSX.Element {
  const [resource, { refetch: refetchSummary }] = createResource(fetchSummary);
  const [usageResource, { refetch: refetchUsage }] = createResource(fetchUsageSummary);
  const [providersResource] = createResource(async (): Promise<readonly CatalogProvider[]> => {
    try {
      return await consoleCatalog();
    } catch {
      return [];
    }
  });
  const [copied, setCopied] = createSignal(false);
  let lastGood: DashboardSummary | null = null;

  onMount(() => {
    const timer = setInterval(() => {
      void refetchSummary();
      void refetchUsage();
    }, SUMMARY_REFRESH_MS);
    onCleanup(() => clearInterval(timer));
  });

  onMount(() => {
    const timer = setInterval(() => void refetchUsage(), TELEMETRY_REFRESH_MS);
    onCleanup(() => clearInterval(timer));
  });

  const summary = createMemo<DashboardSummary | undefined>(() => {
    const result = resource();
    if (result === undefined) return lastGood ?? undefined;
    if (result.ok) lastGood = result.data;
    return lastGood ?? undefined;
  });
  const failed = createMemo(() => {
    const result = resource();
    return result !== undefined && !result.ok;
  });
  const isLoading = () => resource.loading;
  const isError = () => failed() && lastGood === null;
  const endpointUrl = `${window.location.origin}/v1`;

  const usage = createMemo<UsageSummary>(() => usageResource() ?? { requests: null, errors: null, avgDurationMs: null });
  const providers = createMemo<readonly CatalogProvider[]>(() => providersResource() ?? []);
  const providersCount = (): number => providers().length;
  const providersEnabled = (): number => providers().filter((p) => p.enabled).length;

  const errorRatePercent = createMemo<number>(() => {
    const u = usage();
    if (u.requests === null || u.requests <= 0 || u.errors === null) return 0;
    return Math.min(100, Math.max(0, (u.errors / u.requests) * 100));
  });
  const errorRateTone = (): HealthTone => {
    const p = errorRatePercent();
    return p >= 5 ? "err" : p >= 1 ? "warn" : "ok";
  };
  const errorMetricTone = (): IconTone =>
    errorRateTone() === "err" ? "danger" : errorRateTone() === "warn" ? "warning" : errorRateTone() === "ok" ? "success" : "neutral";

  const copyEndpoint = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(endpointUrl);
      setCopied(true);
      toast.success("Endpoint copied", { duration: 2_000 });
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (permissions/insecure context) — copy stays inert.
    }
  };

  const accountsMax = (): number => Math.max(1, summary()?.accountCount ?? 0);
  const proxiesMax = (): number => Math.max(1, summary()?.proxyCount ?? 0);
  const keysMax = (): number => Math.max(1, summary()?.apiKeyCount ?? 0);
  const barPct = (value: number, max: number): number => max <= 0 ? 0 : Math.min(100, (value / max) * 100);

  return (
    <div class="dashboard-page animate-fade-in space-y-4">
      <header class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 class="text-xl font-bold text-[var(--text-1)]">Overview</h2>
          <p class="mt-1 text-[11px] text-[var(--text-2)]">Daemon health and connection facts.</p>
        </div>
      </header>

      <Show
        when={!isLoading() || summary()}
        fallback={
          <div class="h-24 animate-pulse rounded-[var(--radius-card)] bg-[var(--surface-2)]" />
        }
      >
        <Show
          when={!isError()}
          fallback={
            <Card density="comfortable">
              <CardHeader title="Unable to load overview" sub="The daemon dashboard summary could not be read." />
              <Button variant="secondary" onClick={() => void refetchSummary()}>Retry</Button>
            </Card>
          }
        >
          <>
            <Card>
              <CardHeader title="API endpoint" icon={Server} iconColor="var(--accent)" sub="Base URL for OpenAI- and Anthropic-compatible clients" />
              <div class="flex flex-wrap items-center gap-2">
                <code class="min-w-0 flex-1 truncate rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--code-surface)] px-3 py-2 font-mono text-[12px] text-[var(--text-1)]" title={endpointUrl}>
                  {endpointUrl}
                </code>
                <Button size="sm" variant="outline" onClick={() => void copyEndpoint()}>
                  <Show when={copied()} fallback={<Copy size={14} aria-hidden="true" />}>
                    <Check size={14} aria-hidden="true" />
                  </Show>
                  {copied() ? "Copied" : "Copy"}
                </Button>
              </div>
              <p class="mt-2 text-[11px] text-[var(--text-3)]">OpenAI &amp; Anthropic compatible · Copy-ready for clients</p>
            </Card>

            <Card>
              <CardHeader title="System metrics" icon={Activity} iconColor="var(--status-success)" sub={`Last 24 hours · ${summary()?.environment ?? "unknown"} environment`} />

              {/* Primary KPI strip — shares the MetricCard family used across the
                  dashboard for consistent tone + spacing. Latency stays empty
                  until the telemetry/overview contract is wired. */}
              <div class="grid grid-cols-2 gap-3 card-stagger lg:grid-cols-4">
                <MetricCard label="Requests" value={formatNumber(usage().requests)} icon={Activity} tone="info" description="Last 24 hours" />
                <MetricCard label="Errors" value={formatNumber(usage().errors)} icon={TriangleAlert} tone={errorMetricTone()} description={`${errorRatePercent().toFixed(1)}% rate`} />
                <MetricCard label="Latency" value={formatDuration(usage().avgDurationMs)} icon={Timer} tone={usage().avgDurationMs === null ? "neutral" : "accent"} description="Avg duration" />
                <MetricCard label="Providers" value={formatNumber(providersCount())} icon={Globe} tone="success" description={`${providersEnabled()} enabled`} />
              </div>

              {/* Detail grid — Overall RAM + Configuration. */}
              <div class="mt-3 grid grid-cols-1 overflow-hidden rounded-[14px] border border-[var(--inner-border)] sm:grid-cols-2 lg:grid-cols-4">
                <section class="col-span-1 border-b border-[var(--inner-border)] bg-[var(--hover)] p-3.5 sm:col-span-2 lg:col-span-2 lg:border-b-0 lg:border-r">
                  <div class="flex items-center gap-2">
                    <span class="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-[color-mix(in_srgb,var(--purple)_14%,transparent)] text-[var(--purple)]">
                      <MemoryStick size={15} aria-hidden="true" />
                    </span>
                    <h3 class="text-xs font-bold tracking-tight">RAM usage</h3>
                  </div>
                  <div class="mt-4">
                    <StatePanel
                      kind="empty"
                      title="Not available yet"
                      description="Live RAM usage will appear here once the daemon /health/metrics endpoint is connected."
                      density="comfortable"
                    />
                  </div>
                </section>

                <section class="bg-[var(--hover)] p-3.5 sm:col-span-2 lg:col-span-2">
                  <div class="flex items-center gap-2">
                    <span class="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--accent)]">
                      <KeyRound size={15} aria-hidden="true" />
                    </span>
                    <h3 class="text-xs font-bold tracking-tight">Configuration</h3>
                  </div>
                  <div class="mt-4 space-y-2.5">
                    <BarRow label="Accounts" value={summary()?.accountCount ?? 0} pct={barPct(summary()?.accountCount ?? 0, accountsMax())} accentColor="var(--accent)" />
                    <BarRow label="Proxies" value={summary()?.proxyCount ?? 0} pct={barPct(summary()?.proxyCount ?? 0, proxiesMax())} accentColor="var(--status-success)" />
                    <BarRow label="API keys" value={summary()?.apiKeyCount ?? 0} pct={barPct(summary()?.apiKeyCount ?? 0, keysMax())} accentColor="var(--purple)" />
                  </div>
                </section>
              </div>
            </Card>
          </>
        </Show>
      </Show>
    </div>
  );
}

interface BarRowProps {
  label: string;
  value: string | number;
  pct: number;
  accentColor: string;
}

const BarRow = (props: BarRowProps): JSX.Element => (
  <div>
    <div class="mb-0.5 flex justify-between text-[9.5px] text-[var(--text-3)]">
      <span>{props.label}</span>
      <span class="tabular-nums">{typeof props.value === "number" ? props.value.toLocaleString("en-US") : props.value}</span>
    </div>
    <div class="h-1 overflow-hidden rounded-full bg-[var(--track)]">
      <div class="bar-transition h-full origin-left rounded-full" style={{ "background-color": props.accentColor, transform: `scaleX(${Math.max(0, Math.min(1, props.pct / 100))})` }} />
    </div>
  </div>
);

