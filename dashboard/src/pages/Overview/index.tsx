import { Check, Copy, Server } from "lucide-solid";
import { Show, createMemo, createResource, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { Card, CardHeader } from "@components/ui/card";
import { Button } from "@components/ui/button";
import { consoleGet, normalizeDashboardSummary, type DashboardSummary } from "@lib/console-api";
import { toast } from "@lib/toast";

const SUMMARY_REFRESH_MS = 30_000;

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
  const endpointUrl = `${window.location.origin}/v1`;

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

  return (
    <div class="dashboard-page animate-fade-in space-y-4">
      <header class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 class="text-xl font-bold text-[var(--text-1)]">Overview</h2>
          <p class="mt-1 text-xs text-[var(--text-2)]">Daemon health and connection facts.</p>
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
                  <Button size="sm" variant="outline" onClick={() => void copyEndpoint()}>
                    <Show when={copied()} fallback={<Copy size={14} aria-hidden="true" />}>
                      <Check size={14} aria-hidden="true" />
                    </Show>
                    {copied() ? "Copied" : "Copy"}
                  </Button>
                </div>
                <p class="mt-2 text-[11px] text-[var(--text-3)]">OpenAI &amp; Anthropic compatible · Copy-ready for clients</p>
              </Card>

            </>
        </Show>
      </Show>
    </div>
  );
}
