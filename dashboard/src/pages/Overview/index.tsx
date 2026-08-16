import { Check, Clock, Copy, Globe, Key, Leaf, Server, Tag, Users } from "lucide-solid";
import { For, Show, createMemo, createResource, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { Card, CardHeader } from "@components/ui/card";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { MetricCard, MetricCardSkeleton } from "@components/shared/MetricCard";
import { consoleGet, normalizeDashboardSummary, type DashboardSummary } from "@lib/console-api";
import { formatNumber } from "@lib/format";

const SUMMARY_REFRESH_MS = 30_000;

const STATUS_TONE = {
  ready: "success",
  degraded: "warning",
  offline: "danger",
  unknown: "neutral",
} as const;

const dependencyTone = (detail: string): "success" | "warning" | "danger" => {
  if (/offline|down/i.test(detail)) return "danger";
  if (/degrad|error|unavailable/i.test(detail)) return "warning";
  return "success";
};

type HealthStatus = keyof typeof STATUS_TONE;

type SummaryResult = { ok: true; data: DashboardSummary } | { ok: false };

/** The fetcher never rejects: a rejected resource would leave `loading`
 * stuck true in Solid and the skeleton would never yield to the error UI. */
async function fetchSummary(): Promise<SummaryResult> {
  try {
    return { ok: true, data: normalizeDashboardSummary(await consoleGet<unknown>("/dashboard")) };
  } catch {
    return { ok: false };
  }
}

/**
 * Overview — daemon health page, recreated like the classic layout: the
 * client-facing API endpoint, the facts reported by /console/dashboard,
 * dependency health badges, and a readiness note. Data auto-refreshes every
 * 30s; a failed refresh keeps the last accepted summary (marked stale).
 */
export default function Overview(): JSX.Element {
  const [resource, { refetch }] = createResource(fetchSummary);
  const [copied, setCopied] = createSignal(false);
  let lastGood: DashboardSummary | null = null;

  onMount(() => {
    const timer = setInterval(() => void refetch(), SUMMARY_REFRESH_MS);
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
  // Stale: a refresh failed but the last accepted summary is still shown.
  const isStale = () => failed() && lastGood !== null;
  const data = createMemo<DashboardSummary>(() => summary() as DashboardSummary);

  const endpointUrl = `${window.location.origin}/v1`;

  const copyEndpoint = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(endpointUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (permissions/insecure context) — copy stays inert.
    }
  };

  const health = createMemo(() => summary()?.health);
  const overallStatus = createMemo<HealthStatus>(() => health()?.status ?? "unknown");
  const dependencies = createMemo(() => Object.entries(health()?.dependencies ?? {}));

  return (
    <div class="dashboard-page animate-fade-in space-y-4">
      <header class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 class="text-xl font-bold text-[var(--text-1)]">Overview</h2>
          <p class="mt-1 text-xs text-[var(--text-2)]">Daemon health and connection facts.</p>
        </div>
        <Show when={summary()}>
          <Badge tone="neutral" className="font-mono">
            {isStale() ? "Stale" : "Live"}
          </Badge>
        </Show>
      </header>

      <Show
        when={!isLoading() || summary()}
        fallback={
          <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <For each={["Version", "Environment", "Uptime", "Accounts", "Proxies", "API keys"]}>
              {(label) => <MetricCardSkeleton label={label} />}
            </For>
          </div>
        }
      >
        <Show
          when={!isError()}
          fallback={
            <Card density="comfortable">
              <CardHeader title="Unable to load overview" sub="The daemon dashboard summary could not be read." />
              <Button variant="secondary" onClick={() => void refetch()}>Retry</Button>
            </Card>
          }
        >
          <>
              <Card>
                <CardHeader title="API endpoint" icon={Server} iconColor="#0a84ff" sub="Base URL for OpenAI- and Anthropic-compatible clients" />
                <div class="flex flex-wrap items-center gap-2">
                  <code class="min-w-0 flex-1 truncate rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--code-surface)] px-3 py-2 font-mono text-[12px] text-[var(--text-1)]" title={endpointUrl}>
                    {endpointUrl}
                  </code>
                  <Badge tone="neutral">Local</Badge>
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
                <CardHeader title="Daemon summary" sub="Facts reported by /console/dashboard" />
                <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                  <MetricCard label="Version" value={data().version} icon={Tag} tone="info" />
                  <MetricCard label="Environment" value={data().environment} icon={Leaf} tone="neutral" />
                  <MetricCard label="Uptime" value={data().uptime} icon={Clock} tone="success" />
                  <MetricCard label="Accounts" value={formatNumber(data().accountCount)} icon={Users} tone="accent" description="Provider accounts" />
                  <MetricCard label="Proxies" value={formatNumber(data().proxyCount)} icon={Globe} tone="neutral" description="Egress proxies" />
                  <MetricCard label="API keys" value={formatNumber(data().apiKeyCount)} icon={Key} tone="warning" description="Client keys" />
                </div>
              </Card>

              <Card>
                <CardHeader title="Dependency health" sub="Component readiness reported by the daemon" />
                <div class="flex flex-wrap items-center gap-2">
                  <Badge tone={STATUS_TONE[overallStatus()]}>{overallStatus()[0].toUpperCase()}{overallStatus().slice(1)}</Badge>
                  <For each={dependencies()}>
                    {([name, detail]) => (
                      <Badge tone={dependencyTone(detail)}>
                        {name} · {detail}
                      </Badge>
                    )}
                  </For>
                  <Show when={dependencies().length === 0}>
                    <span class="text-[11px] text-[var(--text-3)]">No dependency health reported · Unknown</span>
                  </Show>
                </div>
              </Card>

              <Card density="comfortable">
                <p class="text-xs leading-relaxed text-[var(--text-2)]">
                  {isStale()
                    ? "Showing a previously accepted response — the last refresh failed. Values may lag behind the daemon's current state."
                    : overallStatus() === "ready"
                      ? "The daemon reports all dependencies ready. Summary refreshes automatically every 30 seconds."
                      : "The daemon summary is displayed, but one or more dependencies are not fully ready."}
                </p>
                <Show when={isLoading()}>
                  <p class="mt-1.5 text-[11px] text-[var(--text-3)]" role="status">Refreshing dashboard health…</p>
                </Show>
              </Card>
            </>
        </Show>
      </Show>
    </div>
  );
}
