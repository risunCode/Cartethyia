import { Activity, ChevronDown, ChevronRight, Clock3, Filter, RefreshCw, TriangleAlert } from "lucide-solid";
import { For, Show, createMemo, createResource, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { Badge, type BadgeTone } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { Card, CardHeader } from "@components/ui/card";
import { StatePanel } from "@components/ui/state";
import { TimeRangePicker, type TimeRange } from "@components/forms/TimeRangePicker";
import { consoleFailure, consoleGet } from "@lib/console-api";
import { toast } from "@lib/toast";
import { formatDuration, formatNumber, formatRelativeTime, formatTime } from "@lib/format";
import { serializeTelemetryQuery } from "../../composables/usage/use-usage-resource";

export interface RequestEntry {
  id: string;
  model: string;
  provider: string;
  status: number;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  error?: string;
  client_ip: string;
  created_at: string;
}

export interface RequestListResponse {
  items: readonly RequestEntry[];
  next_cursor: string | null;
  period: TimeRange;
}

const REQUESTS_REFRESH_MS = 15_000;
const REQUESTS_LIMIT = 100;

/** Maps an HTTP status code to a StatusBadge tone. 2xx green, 4xx yellow, 5xx red, others neutral. */
export function statusTone(status: number): BadgeTone {
  if (status >= 200 && status < 300) return "success";
  if (status >= 400 && status < 500) return "warning";
  if (status >= 500 && status < 600) return "danger";
  return "neutral";
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : null;
}

function boundedString(value: unknown, max = 256): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * Normalises an unknown payload from /console/telemetry/requests into a typed
 * list. A malformed payload degrades to an empty list rather than failing
 * the page so partial data still renders.
 */
function normalizeRequestList(value: unknown, period: TimeRange): RequestListResponse {
  const empty: RequestListResponse = { items: [], next_cursor: null, period };
  if (typeof value !== "object" || value === null) return empty;
  const record = value as Record<string, unknown>;
  const rawItems = Array.isArray(record.items) ? record.items : Array.isArray(record.requests) ? record.requests : null;
  if (rawItems === null) return empty;
  const items: RequestEntry[] = [];
  for (const raw of rawItems) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const id = boundedString(entry.id) ?? boundedString(entry.request_id) ?? boundedString(entry.created_at);
    if (id === null) continue;
    items.push({
      id,
      model: boundedString(entry.model) ?? "—",
      provider: boundedString(entry.provider) ?? "—",
      status: typeof entry.status === "number" && Number.isFinite(entry.status) ? entry.status : 0,
      latency_ms: finiteOrNull(entry.latency_ms) ?? 0,
      input_tokens: finiteOrNull(entry.input_tokens) ?? 0,
      output_tokens: finiteOrNull(entry.output_tokens) ?? 0,
      error: boundedString(entry.error) ?? undefined,
      client_ip: boundedString(entry.client_ip) ?? "—",
      created_at: boundedString(entry.created_at) ?? "",
    });
  }
  return {
    items,
    next_cursor: boundedString(record.next_cursor),
    period,
  };
}

/** Fetches the request list for the requested period. */
async function fetchRequests(period: TimeRange): Promise<RequestListResponse> {
  const query = serializeTelemetryQuery({ period, limit: REQUESTS_LIMIT });
  const payload = await consoleGet<unknown>(`/telemetry/requests?${query}`);
  return normalizeRequestList(payload, period);
}

const TONE_BG: Record<BadgeTone, string> = {
  success: "var(--status-success)",
  warning: "var(--status-warning)",
  danger: "var(--status-danger)",
  info: "var(--status-info)",
  accent: "var(--accent)",
  neutral: "var(--text-2)",
  default: "var(--text-2)",
  ok: "var(--status-success)",
  err: "var(--status-danger)",
  warn: "var(--status-warning)",
};

function statusBadgeClass(status: number): string {
  const tone = TONE_BG[statusTone(status)];
  return `bg-[${tone}1f] text-[${tone}]`;
}

function RequestRowDetail(props: { entry: RequestEntry }): JSX.Element {
  return (
    <div class="grid gap-3 px-4 py-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="request-detail">
      <DetailField label="Request ID" value={props.entry.id} mono />
      <DetailField label="Model" value={props.entry.model} />
      <DetailField label="Provider" value={props.entry.provider} />
      <DetailField label="Status" value={String(props.entry.status) || "—"} />
      <DetailField label="Latency" value={formatDuration(props.entry.latency_ms)} />
      <DetailField label="Input tokens" value={formatNumber(props.entry.input_tokens)} />
      <DetailField label="Output tokens" value={formatNumber(props.entry.output_tokens)} />
      <DetailField label="Client IP" value={props.entry.client_ip} mono />
      <DetailField label="Timestamp" value={formatTime(props.entry.created_at)} sub={formatRelativeTime(props.entry.created_at)} />
      <Show when={props.entry.error}>
        <div class="sm:col-span-2 lg:col-span-4">
          <div class="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Error</div>
          <div class="mt-1 break-words rounded-md border border-[var(--status-danger)]/30 bg-[var(--status-danger)]/10 px-2.5 py-1.5 font-mono text-[11px] text-[var(--status-danger)]">
            {props.entry.error}
          </div>
        </div>
      </Show>
    </div>
  );
}

function DetailField(props: { label: string; value: string; sub?: string; mono?: boolean }): JSX.Element {
  return (
    <div>
      <div class="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">{props.label}</div>
      <div class="mt-1 truncate text-xs text-[var(--text-1)]" classList={{ "font-mono": props.mono === true }}>
        {props.value}
      </div>
      <Show when={props.sub}>
        <div class="text-[10px] text-[var(--text-3)]">{props.sub}</div>
      </Show>
    </div>
  );
}

export default function Requests(): JSX.Element {
  const [period, setPeriod] = createSignal<TimeRange>(
    typeof window !== "undefined"
      ? ((new URLSearchParams(window.location.search).get("period") as TimeRange | null) ?? "24h")
      : "24h",
  );
  const [expandedId, setExpandedId] = createSignal<string | null>(null);
  const [resource, { refetch }] = createResource(period, fetchRequests);

  onMount(() => {
    const timer = setInterval(() => void refetch(), REQUESTS_REFRESH_MS);
    onCleanup(() => clearInterval(timer));
  });

  const isLoading = () => resource.loading;
  const isError = () => resource.error !== undefined;
  const errorInfo = createMemo(() => (resource.error ? consoleFailure(resource.error) : null));
  const items = createMemo<readonly RequestEntry[]>(() => (resource.error ? [] : resource()?.items ?? []));

  const handleManualRefresh = async () => {
    try {
      await refetch();
    } catch (error) {
      const failure = consoleFailure(error);
      toast.error(failure?.message ?? "Failed to refresh requests");
    }
  };

  const totals = createMemo(() => {
    const rows = items();
    let total = rows.length;
    let errors = 0;
    let latencySum = 0;
    let latencyCount = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    for (const row of rows) {
      if (row.status >= 400) errors++;
      if (row.latency_ms > 0) {
        latencySum += row.latency_ms;
        latencyCount++;
      }
      tokensIn += row.input_tokens;
      tokensOut += row.output_tokens;
    }
    return {
      total,
      errors,
      avgLatency: latencyCount > 0 ? Math.round(latencySum / latencyCount) : 0,
      tokensIn,
      tokensOut,
    };
  });

  return (
    <div class="dashboard-page animate-fade-in space-y-5">
      <header class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 class="text-xl font-bold text-[var(--text-1)]">Requests</h2>
          <p class="mt-1 text-xs text-[var(--text-2)]">
            Live request telemetry from the API. Auto-refreshes every 15 seconds.
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <TimeRangePicker value={period()} onChange={setPeriod} ariaLabel="Requests time range" />
          <Button size="sm" variant="secondary" onClick={() => void handleManualRefresh()} disabled={isLoading()}>
            <RefreshCw class={["h-3.5 w-3.5", isLoading() ? "animate-spin" : ""].join(" ")} />
            Refresh
          </Button>
        </div>
      </header>

      <section aria-label="Request summary" class="grid grid-cols-2 gap-3 card-stagger lg:grid-cols-4">
        <SummaryCard icon={Activity} tone="accent" label="Total requests" value={formatNumber(totals().total)} sub={`Last ${period()}`} />
        <SummaryCard icon={TriangleAlert} tone="danger" label="Errors" value={formatNumber(totals().errors)} sub="4xx + 5xx" />
        <SummaryCard icon={Clock3} tone="info" label="Avg latency" value={formatDuration(totals().avgLatency)} sub="Completed requests" />
        <SummaryCard icon={Filter} tone="success" label="Tokens (in / out)" value={`${formatNumber(totals().tokensIn)} / ${formatNumber(totals().tokensOut)}`} sub="Window total" />
      </section>

      <Show
        when={!isError()}
        fallback={
          <StatePanel
            kind={errorInfo()?.degraded ? "degraded" : "error"}
            title={errorInfo()?.degraded ? "Request telemetry degraded" : "Failed to load requests"}
            description={errorInfo()?.message ?? "Unknown error"}
            action={
              <Button variant="secondary" onClick={() => void handleManualRefresh()}>
                Retry
              </Button>
            }
          />
        }
      >
        <Card density="compact" className="animate-fade-in">
          <CardHeader title="Recent requests" icon={Activity} iconColor="#0a84ff" sub={`Showing up to ${REQUESTS_LIMIT} requests for ${period()}`}>
            <Badge tone="info" className="font-mono">
              {totals().total} rows
            </Badge>
          </CardHeader>
          <Show
            when={!isLoading() || items().length > 0}
            fallback={
              <div class="space-y-2" aria-label="Loading requests">
                <div class="h-4 w-full animate-pulse rounded bg-[var(--surface-muted)]" />
                <div class="h-4 w-5/6 animate-pulse rounded bg-[var(--surface-muted)]" />
                <div class="h-4 w-2/3 animate-pulse rounded bg-[var(--surface-muted)]" />
              </div>
            }
          >
            <Show
              when={items().length > 0}
              fallback={
                <StatePanel
                  kind="empty"
                  title="No requests yet"
                  description={`No requests have been recorded for the last ${period()}.`}
                  icon={Activity}
                  density="compact"
                />
              }
            >
              <RequestList
                items={items()}
                expandedId={expandedId()}
                onToggle={(id) => setExpandedId((current) => (current === id ? null : id))}
              />
            </Show>
          </Show>
        </Card>
      </Show>
    </div>
  );
}

function RequestList(props: {
  items: readonly RequestEntry[];
  expandedId: string | null;
  onToggle: (id: string) => void;
}): JSX.Element {
  return (
    <div class="flex flex-col gap-2">
      <For each={props.items}>
        {(entry) => {
          const isExpanded = () => props.expandedId === entry.id;
          return (
            <div class="overflow-hidden rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--surface-1)] transition-colors hover:border-[var(--text-3)]/40">
              <button
                type="button"
                class="grid w-full cursor-pointer items-center text-left transition-colors hover:bg-[var(--hover)]"
                style={{ "grid-template-columns": "32px 22% 16% 10% 10% 10% 10% 22%" }}
                aria-expanded={isExpanded()}
                aria-controls={`request-detail-${entry.id}`}
                onClick={() => props.onToggle(entry.id)}
              >
                <span class="grid h-5 w-5 place-items-center justify-self-start text-[var(--text-2)]">
                  <Show when={isExpanded()} fallback={<ChevronRight class="h-3.5 w-3.5" />}>
                    <ChevronDown class="h-3.5 w-3.5" />
                  </Show>
                </span>
                <span class="truncate px-2 text-left font-mono text-[11px] text-[var(--text-1)]">{entry.model}</span>
                <span class="truncate px-2 text-left text-[11px] text-[var(--text-2)]">{entry.provider}</span>
                <span class="px-2 text-center">
                  <span class={["inline-flex items-center rounded-md px-1.5 py-0.5 font-mono text-[11px] font-semibold", statusBadgeClass(entry.status)].join(" ")}>
                    {entry.status || "—"}
                  </span>
                </span>
                <span class="px-2 text-right font-mono text-[11px] tabular-nums">{formatDuration(entry.latency_ms)}</span>
                <span class="px-2 text-right font-mono text-[11px] tabular-nums text-[var(--text-2)]">{formatNumber(entry.input_tokens)}</span>
                <span class="px-2 text-right font-mono text-[11px] tabular-nums text-[var(--text-2)]">{formatNumber(entry.output_tokens)}</span>
                <span class="px-2 text-right text-[11px] tabular-nums text-[var(--text-2)]" title={formatTime(entry.created_at)}>
                  {formatRelativeTime(entry.created_at)}
                </span>
              </button>
              <Show when={isExpanded()}>
                <div id={`request-detail-${entry.id}`} class="border-t border-[var(--inner-border)] bg-[var(--surface-muted)]/40">
                  <RequestRowDetail entry={entry} />
                </div>
              </Show>
            </div>
          );
        }}
      </For>
    </div>
  );
}

function SummaryCard(props: { icon: typeof Activity; label: string; value: string; sub: string; tone: BadgeTone }): JSX.Element {
  const Icon = props.icon;
  const accent = TONE_BG[props.tone];
  return (
    <div class="flex items-center gap-3 rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--surface-1)] px-3 py-2.5">
      <span class="grid h-8 w-8 shrink-0 place-items-center rounded-md" style={{ "background-color": `${accent}1f`, color: accent }}>
        <Icon class="h-4 w-4" />
      </span>
      <div class="min-w-0 flex-1">
        <div class="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">{props.label}</div>
        <div class="truncate font-mono text-sm font-semibold text-[var(--text-1)]">{props.value}</div>
        <div class="text-[10px] text-[var(--text-3)]">{props.sub}</div>
      </div>
    </div>
  );
}
