import { cn } from "../../lib/cn";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  ArrowUpFromLine,
  Check,
  CheckCircle2,
  ChevronDown,
  Coins,
  Copy,
  Database,
  DollarSign,
  Eye,
  EyeOff,
  Image as ImageIcon,
  LogIn,
  Maximize2,
  Minimize2,
  Paperclip,
  Radio,
  Route,
  Scaling,
  Server,
  Wrench,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { DataTable, StatCard } from "../../components/ui/layout";
import { EmptyState, ErrorState, LoadingState } from "../../components/ui/state";
import { Drawer } from "../../components/ui/drawer";
import { Select } from "../../components/ui/select";
import { Inline } from "../../components/ui/inline";
import { Stack } from "../../components/ui/stack";
import { useReducedMotion } from "../../hooks/use-reduced-motion";
import {
  useUsageBy,
  useUsageChart,
  useUsageRequestDetail,
  useUsageRequests,
  useUsageSummary,
} from "../../hooks/system";
import { requestProviderId } from "../../features/usage/request-provider";
import { usageApiKeyLabel, usageClientLabel } from "../../features/usage/usage-labels";

import { useProviderAccounts, useProviders } from "../../hooks/providers";
import { useInFlight, type InFlightState } from "../../hooks/live";
import { useTrackedTimeout } from "../../hooks/use-timeout";
import { USAGE_PERIODS, type UsagePeriod as Period } from "../../data/usage-periods";
import { httpStatusLabel, httpStatusShortLabel, httpStatusTone } from "../../features/usage/http-status";
import { USAGE_DIMENSIONS, type UsageDimension, type UsageSummaryTotals } from "../../data/contracts";
import {
  DEFAULT_TOKEN_SCALE,
  RAW_TOKEN_SCALE,
  TOKEN_SCALE_AUTO,
  TOKEN_SCALES,
  formatBytes,
  formatChartTick,
  formatChartTooltip,
  formatCredits,
  formatDuration,
  formatNumber,
  formatTokens,
  tokenScaleIndex,
  tokenScaleValue,
} from "../../lib/format";

type Metric = "requests" | "tokens" | "cached";
/** Mirrors the backend `USAGE_DIMENSIONS`; keep in sync by hand. */
type Dimension = UsageDimension;

/** Breakdown rows the panel holds before it scrolls; the rest scrolls inside.
 *  The body is locked to this height so the card keeps it when the list is
 *  empty, loading, or short. */
const BREAKDOWN_VISIBLE_ROWS = 5;
/** Measured row box (39px) plus the 8px flex gap, minus the trailing gap. */
const BREAKDOWN_LIST_HEIGHT = BREAKDOWN_VISIBLE_ROWS * 47 - 8;


/**
 * Payload panels shown in the request inspector. The client leg (what the
 * client sent / what Cartethyia produced / what the client actually received)
 * comes first; the provider leg (what was forwarded upstream / what the
 * upstream returned) follows so proxy and server legs are readable separately.
 * Provider internals stay redacted and bounded at the source
 * (`completeAttempt` capture), never raw secrets.
 */
type PayloadKind = "request" | "clientResponse" | "providerRequest" | "providerResponse";

function formatPayload(value: unknown): { readonly text: string; readonly bytes: number } {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(value) as unknown;
        const text = JSON.stringify(parsed, null, 2);
        return { text, bytes: new TextEncoder().encode(value).byteLength };
      } catch {
        return { text: value, bytes: new TextEncoder().encode(value).byteLength };
      }
    }
    return { text: value, bytes: new TextEncoder().encode(value).byteLength };
  }
  const text = JSON.stringify(value, null, 2);
  return { text, bytes: new TextEncoder().encode(JSON.stringify(value)).byteLength };
}

const PERIOD_LABELS: Record<Period, string> = {
  "1h": "Last 1 Hour",
  "6h": "Last 6 Hours",
  "12h": "Last 12 Hours",
  "24h": "Last 24 Hours",
  "7d": "Last 7 Days",
  "30d": "Last 30 Days",
  all: "All retained",
};
const PERIOD_OPTIONS = USAGE_PERIODS.map((value) => ({
  value,
  label: PERIOD_LABELS[value as Period] ?? value,
}));

function periodLabel(period: Period): string {
  return PERIOD_LABELS[period] ?? period;
}

/**
 * The card headline. The period alone read as a label with nothing under it,
 * so it carries what moved in the period: how many calls, how many tokens,
 * and how long a call took on average.
 */
function usageHeadline(
  period: Period,
  pending: boolean,
  totals: UsageSummaryTotals | undefined,
): string {
  const label = periodLabel(period);
  if (pending || totals === undefined) return label;
  const tokens = totals.inputTokens + totals.cachedTokens + totals.outputTokens;
  return `${label} · ${formatNumber(totals.requests)} calls · ${formatTokens(tokens)} tokens · avg ${formatDuration(totals.avgDurationMs)}`;
}

function asPeriod(value: string | null): Period {
  return value !== null && (USAGE_PERIODS as readonly string[]).includes(value)
    ? (value as Period)
    : "24h";
}

function asMetric(value: string | null): Metric {
  return value === "tokens" || value === "cached" ? value : "requests";
}
/**
 * Resolves the card scale. No `scale` param means the exact count (the
 * default); `scale=auto` asks for the compact unit the value lands on; a
 * number pins one of `TOKEN_SCALES`.
 */
function asTokenScale(value: string | null): number {
  if (value === null) return DEFAULT_TOKEN_SCALE;
  if (value === "auto") return TOKEN_SCALE_AUTO;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= RAW_TOKEN_SCALE ? parsed : DEFAULT_TOKEN_SCALE;
}

function asDimension(value: string | null): Dimension {
  return value !== null && (USAGE_DIMENSIONS as readonly string[]).includes(value)
    ? (value as Dimension)
    : "model";
}

function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}
/**
 * Provider-billed credits (Tencent buddy-meter `credit`) with the unit label:
 * two decimals like the live probe reported (`1.01`), `—` when the upstream
 * sent no credit. The numeric formatting delegates to the shared
 * `formatCredits`, so this page and the provider-detail credit pool round the
 * same way; only the ` CR` suffix is local here.
 */
export function formatCredit(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${formatCredits(value)} CR`;
}
function formatSpeed(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return "—";
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded.toLocaleString("en-US")} tok/s`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}


/**
 * Wire surface mapped to its protocol family name for the status cell.
 * The `API KEY` column already identifies the client, so the status cell
 * names only the protocol family — never the endpoint or client string.
 */
export function surfaceFamilyLabel(surface: string | undefined): string {
  switch (surface) {
    case "chat":
      return "OpenAI Completions";
    case "messages":
      return "Anthropic Messages";
    case "responses":
      return "OpenAI Responses";
    case "completion":
      return "OpenAI Completions";
    default:
      return surface ? surface : "—";
  }
}

/**
 * Relative age of a request start for the time cell's second line:
 * minutes below an hour, hours below a day, days below a week, weeks above.
 * Pure display — the absolute clock stays on the first line.
 */
export function formatAgo(value: string, nowMs: number = Date.now()): string {
  const started = new Date(value).getTime();
  if (Number.isNaN(started)) return "—";
  const diffMs = Math.max(0, nowMs - started);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  if (diffMs < hour) {
    const minutes = Math.max(0, Math.floor(diffMs / minute));
    return minutes <= 1 ? "just now" : `${minutes}m ago`;
  }
  if (diffMs < day) {
    const hours = Math.floor(diffMs / hour);
    return hours <= 1 ? "1h ago" : `${hours}h ago`;
  }
  if (diffMs < week) {
    const days = Math.floor(diffMs / day);
    return days <= 1 ? "1d ago" : `${days}d ago`;
  }
  const weeks = Math.floor(diffMs / week);
  return weeks <= 1 ? "1w ago" : `${weeks}w ago`;
}

/**
 * Lifecycle status mapped to an HTTP-style code label for the compact table cell.
 *
 * `cancelled` renders as `499` (client closed the request) — a distinct status
 * from `500 ERR`: it is expected client behavior, not a gateway failure, and
 * is never counted in any error total. The code cell carries the explainer so
 * the distinction is visible exactly where the number appears.
 */
function statusCode(
  status: string,
  httpStatus?: number,
): { code: string; tone: "ok" | "err" | "warn" } {
  if (httpStatus !== undefined) {
    const tone = httpStatus >= 500 || (httpStatus >= 400 && httpStatus !== 499)
      ? "err"
      : httpStatus === 200
        ? "ok"
        : "warn";
    return { code: httpStatusShortLabel(httpStatus), tone };
  }
  switch (status) {
    case "completed":
      return { code: httpStatusShortLabel(200), tone: "ok" };
    case "failed":
      return { code: httpStatusShortLabel(500), tone: "err" };
    case "cancelled":
      return { code: httpStatusShortLabel(499), tone: "warn" };
    case "truncated":
      return { code: httpStatusShortLabel(502), tone: "err" };
    default:
      return { code: status, tone: "warn" };
  }
}

/** The full-phrase code for the explainer: `500` -> `"500 Internal Server Error"`. */
function statusFullCode(status: string, httpStatus?: number): string {
  if (httpStatus !== undefined) return httpStatusLabel(httpStatus);
  switch (status) {
    case "completed":
      return httpStatusLabel(200);
    case "failed":
      return httpStatusLabel(500);
    case "cancelled":
      return httpStatusLabel(499);
    case "truncated":
      return httpStatusLabel(502);
    default:
      return status;
  }
}

/** One-line explainer for the actual client-facing HTTP status. */
function statusExplainer(
  status: string,
  errorKind: string | undefined,
  httpStatus?: number,
): string {
  if (httpStatus === 499 || status === "cancelled") {
    return `499 · client aborted the request (${errorKind ?? "cancelled"}) — not a gateway error`;
  }
  if (httpStatus === 200 || status === "completed") return "200 · request succeeded";
  const code = statusFullCode(status, httpStatus);
  return errorKind ? `${code} · ${errorKind}` : code;
}

/**
 * `200` confirms success, `499` names the client abort so a cancelled row is
 * never mistaken for a gateway error. Pure display — no error totals change.
 */
function StatusCodeWithExplainer({
  status,
  errorKind,
  httpStatus,
}: {
  readonly status: string;
  readonly errorKind: string | undefined;
  readonly httpStatus?: number;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const code = statusCode(status, httpStatus);
  const explainer = statusExplainer(status, errorKind, httpStatus);
  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        aria-expanded={open}
        aria-label={explainer}
        title={explainer}
        className={cn(
          "font-mono font-bold tabular-nums bg-transparent border border-transparent",
          "rounded-[6px] cursor-pointer px-[4px] py-0 text-[inherit]",
        )}
        style={{ color: STATUS_TONE_COLOR[code.tone] }}
      >
        {code.code}
      </button>
      {open ? (
        <span
          role="status"
          className="absolute z-30 top-[calc(100%+6px)] left-0 whitespace-normal min-w-[220px] max-w-[280px] border border-inner-border rounded-[10px] bg-popover-bg shadow-[0_12px_32px_rgba(0,0,0,0.16)] px-[10px] py-[8px] font-sans font-normal text-[11px] leading-[1.5] text-text-secondary"
        >
          {explainer}
        </span>
      ) : null}
    </span>
  );
}
function errorMessageFor(errorKind: string | undefined): string {
  const messages: Record<string, string> = {
    transport_closed: "request was cancelled by client",
    transport_unavailable: "upstream stream failed or ended before completion",
    timeout: "request timed out before a response was received",
    deadline_exceeded: "upstream stream stalled past the deadline",
    invalid_request: "request was rejected as invalid",
    internal_error: "the gateway was misconfigured for this request",
    provider_error: "upstream provider returned an error",
    platform_unavailable: "upstream provider was unavailable",
    proxy_unreachable: "network proxy was unreachable",
    proxy_auth_required: "network proxy rejected the credential",
    quota_exceeded: "upstream rate limit or quota was exceeded",
    authentication_failed: "upstream rejected the credential",
    capacity_exhausted: "upstream capacity was exhausted",
    model_not_found: "no route served this model",
    context_length_exceeded: "the request exceeded the model's context window",
    capability_unsupported: "the route does not support this request",
    admission_unavailable: "gateway dependencies were unavailable",
    unknown_error: "the upstream failure could not be classified",
    // Codes that previously had no entry and fell through to a mechanical
    // underscore-to-space rendering of the raw code.
    accounts_unavailable: "no account for this route was available",
    accounts_rate_limited: "every account for this route is rate limited or cooling down",
    ambiguous_model: "the model id matched more than one route",
    invalid_pool_limits: "the network pool limits were rejected",
    max_connections_exceeded: "the connection ceiling was reached",
    proxy_pool_capacity_exceeded: "the proxy pool had no free slot",
    proxy_pool_cooldown: "the proxy pool is cooling down",
    proxy_pool_unavailable: "no usable proxy pool was available",
    proxy_pool_unhealthy: "the selected proxy pool could not establish a tunnel",
    slug_reserved: "that slug is reserved by the gateway",
    tenant_capacity_exhausted: "the tenant concurrency ceiling was reached",
    tls_rejected: "the upstream TLS handshake was rejected",
    tool_call_loop_detected: "the request looped on the same tool call",
    tunnel_setup_failed: "the tunnel could not be established",
    unsupported_field: "the request carried a field this route rejects",
    shutting_down: "the gateway was draining for a restart",
    restart_for_update: "the gateway was restarting for an update; retry shortly",
  };
  if (errorKind && messages[errorKind]) return messages[errorKind];
  if (errorKind) return errorKind.replaceAll("_", " ");
  return "request failed";
}

/**
 * Names the failing layer before the message.
 *
 * `invalid_request` is recorded both when the caller's body is malformed (our
 * rejection) and when the upstream rejects a well-formed body (theirs). Without
 * the layer, an operator cannot tell whether to look at the router or at the
 * provider — which is the whole point of recording `error_origin`.
 */
function originLabel(errorOrigin: string | undefined): string {
  if (errorOrigin === "cartethyia") return "Gateway";
  if (errorOrigin === "upstream") return "Upstream";
  if (errorOrigin === "network") return "Network";
  return "";
}

/**
 * Drawer headline for a failed or cancelled request. A client abort is not an
 * error: the headline says so explicitly instead of blaming the gateway.
 */
function errorLabel(
  status: string,
  errorKind: string | undefined,
  errorOrigin: string | undefined,
  httpStatus?: number,
): string {
  if (status === "cancelled") {
    const layer = originLabel(errorOrigin);
    const message = errorMessageFor(errorKind);
    return layer
      ? `Cancelled 499 · ${layer}: ${message} — not a gateway error`
      : `Cancelled 499: ${message} — not a gateway error`;
  }
  const code = statusCode(status, httpStatus).code.split(" ", 1)[0] ?? status;
  const layer = originLabel(errorOrigin);
  const message = errorMessageFor(errorKind);
  return layer ? `${message} · ${code} · ${layer}` : `${message} · ${code}`;
}

const STATUS_TONE_COLOR: Record<"ok" | "err" | "warn", string> = {
  ok: "var(--green)",
  err: "var(--red)",
  warn: "var(--orange)",
};
function PillTabs<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  readonly options: ReadonlyArray<{ readonly id: T; readonly label: string }>;
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly ariaLabel: string;
}): ReactNode {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="flex flex-wrap gap-[4px] min-w-0"
    >
      {options.map((option) => (
        <Button
          key={option.id}
          role="tab"
          aria-selected={value === option.id}
          variant={value === option.id ? "primary" : "secondary"}
          size="sm"
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}

/** Which panel a control refers to: the traffic chart or the breakdown list. */
type PanelKey = "traffic" | "breakdown";

/**
 * Width control for one panel, rendered at the far left of the card header.
 *
 * Widening makes the panel span both grid columns — the one thing the
 * side-by-side layout cannot do on its own, for a chart or list that needs the
 * full row.
 */
function PanelWidthToggle({
  label,
  wide,
  onToggleWide,
}: {
  readonly label: string;
  readonly wide: boolean;
  readonly onToggleWide: () => void;
}): ReactNode {
  return (
    <Button
      size="icon"
      variant="ghost"
      aria-label={wide ? `Restore ${label} width` : `Widen ${label}`}
      aria-pressed={wide}
      title={wide ? "Restore width" : "Widen"}
      icon={wide ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
      onClick={onToggleWide}
    />
  );
}

/** Statuses pinned as chips; everything else folds into the "More" menu. */
const PINNED_STATUS = 200;

function StatusFilterButton({
  status,
  count,
  pressed,
  onToggle,
}: {
  readonly status: number;
  readonly count: number;
  readonly pressed: boolean;
  readonly onToggle: (status: number) => void;
}): ReactNode {
  const label = httpStatusLabel(status);
  return (
    <button
      type="button"
      className="usage-status-filter"
      data-tone={httpStatusTone(status)}
      aria-pressed={pressed}
      aria-label={`Filter ${label}: ${formatNumber(count)} requests`}
      title={`Show ${formatNumber(count)} requests with HTTP ${label}`}
      onClick={() => onToggle(status)}
    >
      <span>{label}</span>
      <span className="usage-status-filter-count">{formatNumber(count)}</span>
    </button>
  );
}

/**
 * HTTP status filters for the Requests table. `200 OK` stays a chip; the rest
 * live in a menu so a period full of errors does not flood the header.
 */
function StatusFilters({
  counts,
  active,
  onToggle,
}: {
  readonly counts: readonly { readonly status: number; readonly count: number }[];
  readonly active: number | null;
  readonly onToggle: (status: number) => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const present = counts.filter((entry) => entry.count > 0);
  const pinned = present.filter((entry) => entry.status === PINNED_STATUS);
  const rest = present.filter((entry) => entry.status !== PINNED_STATUS);
  const restTotal = rest.reduce((sum, entry) => sum + entry.count, 0);
  const restActive = rest.some((entry) => entry.status === active);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (present.length === 0) return null;
  return (
    <div className="usage-status-filters" role="group" aria-label="Filter requests by HTTP status">
      {pinned.map((entry) => (
        <StatusFilterButton
          key={entry.status}
          status={entry.status}
          count={entry.count}
          pressed={active === entry.status}
          onToggle={onToggle}
        />
      ))}
      {rest.length > 0 ? (
        <div ref={rootRef} className="relative">
          <button
            type="button"
            className="usage-status-filter"
            data-tone={restActive ? httpStatusTone(active ?? 0) : undefined}
            aria-pressed={restActive}
            aria-expanded={open}
            aria-haspopup="menu"
            aria-label={`More statuses: ${formatNumber(restTotal)} requests across ${rest.length}`}
            onClick={() => setOpen((value) => !value)}
          >
            <span>More</span>
            <span className="usage-status-filter-count">{formatNumber(restTotal)}</span>
            <ChevronDown size={10} aria-hidden="true" className={cn("transition-transform", open && "rotate-180")} />
          </button>
          {open ? (
            <div
              role="menu"
              aria-label="Other HTTP statuses"
              className="absolute z-[50] top-[calc(100%+4px)] right-0 min-w-[180px] flex flex-col gap-[2px] border border-inner-border rounded-[10px] bg-popover-bg shadow-popout p-[4px]"
            >
              {rest.map((entry) => (
                <div key={entry.status} role="none" className="[&>button]:w-full [&>button]:justify-between">
                  <StatusFilterButton
                    status={entry.status}
                    count={entry.count}
                    pressed={active === entry.status}
                    onToggle={(status) => {
                      onToggle(status);
                      setOpen(false);
                    }}
                  />
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ChartPanel({ period, metric }: { readonly period: Period; readonly metric: Metric }): ReactNode {
  const chartQuery = useUsageChart(period);
  const reducedMotion = useReducedMotion();
  const buckets = useMemo(
    () => (chartQuery.data?.buckets ?? []).map((bucket) => ({ ...bucket, total: bucket.input + bucket.output })),
    [chartQuery.data],
  );
  const dataKey = metric === "requests" ? "requests" : metric === "cached" ? "cached" : "total";
  // The backend fills every bucket of the window, so an idle period arrives as
  // a full series of zeroes rather than an empty array. A chart of that draws
  // nothing — a blank strip — so it reads as empty instead.
  const hasTraffic = buckets.some((bucket) => bucket[dataKey] > 0);
  if (chartQuery.isPending && !hasTraffic) {
    return <LoadingState label="Loading chart…" />;
  }
  if (chartQuery.isError && !hasTraffic) {
    return <ErrorState message="Failed to load chart data." onRetry={() => void chartQuery.refetch()} />;
  }
  if (!hasTraffic) {
    return (
      <EmptyState
        title="No usage for this period"
        message="Route requests to populate the usage."
      />
    );
  }
  return (
    <div className="usage-panel-body h-[227px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={buckets} margin={{ top: 8, right: 8, left: -14, bottom: 0 }}>
          <defs>
            <linearGradient id="usageChartFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.45} />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--inner-border)" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="t"
            tick={{ fontSize: 10, fill: "var(--text-tertiary)" }}
            tickFormatter={(value: string) => formatChartTick(value)}
            axisLine={false}
            tickLine={false}
            minTickGap={28}
          />
          <YAxis
            tick={{ fontSize: 10, fill: "var(--text-tertiary)" }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(value: number) => formatTokens(value)}
            width={48}
          />
          <Tooltip
            contentStyle={{
              background: "var(--surface-2)",
              border: "1px solid var(--inner-border)",
              borderRadius: 12,
              fontSize: 12,
              color: "var(--text-primary)",
            }}
            formatter={(value) => [formatNumber(Number(value)), metric]}
            labelFormatter={(label) => formatChartTooltip(String(label))}
          />
          <Area
            type="monotone"
            dataKey={dataKey}
            stroke="var(--accent)"
            strokeWidth={2}
            fill="url(#usageChartFill)"
            isAnimationActive={!reducedMotion}
            animationDuration={250}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function BreakdownSnapshot({
  period,
  dimension,
  onDimensionChange,
  wide,
  onToggleWide,
}: {
  readonly period: Period;
  readonly dimension: Dimension;
  readonly onDimensionChange: (value: Dimension) => void;
  readonly wide: boolean;
  readonly onToggleWide: () => void;
}): ReactNode {
  const byQuery = useUsageBy(period, dimension);
  const providersQuery = useProviders();
  const providerNames = useMemo(
    () => new Map((providersQuery.data ?? []).map((provider) => [provider.providerId, provider.label || provider.displayName])),
    [providersQuery.data],
  );
  // A response that names another dimension is a tab the operator already left.
  // Showing it would leave the list unchanged after the click.
  const rows = byQuery.data?.dimension === dimension ? byQuery.data.rows : [];
  const maxTotal = rows.length > 0 ? Math.max(...rows.map((row) => row.total)) : 1;
  const totalRequests = rows.reduce((sum, row) => sum + row.requests, 0);
  const totalErrors = rows.reduce((sum, row) => sum + row.errors, 0);
  const breakdownSubtitle = (() => {
    if (byQuery.isPending && rows.length === 0) return "Loading…";
    if (rows.length === 0) return "No traffic in this period";
    const ok = Math.max(0, totalRequests - totalErrors);
    const pct = totalRequests > 0 ? Math.round((ok / totalRequests) * 100) : 0;
    const plural = rows.length === 1 ? "group" : "groups";
    return `${rows.length} ${plural} · ${formatNumber(totalRequests)} hits · ${pct}% ok`;
  })();
  return (
    <Card className={wide ? "grid-span-full" : ""}>
      <CardHeader
        title="Breakdown"
        subtitle={breakdownSubtitle}
        icon={<Wrench size={16} />}
        leading={
          <PanelWidthToggle label="Breakdown" wide={wide} onToggleWide={onToggleWide} />
        }
        action={
          <PillTabs
            ariaLabel="Breakdown dimension"
            value={dimension}
            onChange={onDimensionChange}
            options={[
              { id: "model", label: "Model" },
              { id: "provider", label: "Provider" },
              { id: "client", label: "Client" },
              { id: "client_ip", label: "Client IP" },
              { id: "key", label: "Key" },
            ]}
          />
        }
      />
      <CardBody style={{ height: `${BREAKDOWN_LIST_HEIGHT}px` }}>
        {byQuery.isPending && rows.length === 0 ? (
          <LoadingState label="Loading breakdown…" />
        ) : byQuery.isError && rows.length === 0 ? (
          <ErrorState message="Failed to load breakdown." onRetry={() => void byQuery.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState title="No usage for this period" message="Route requests to populate the breakdown." />
        ) : (
          <div
            className="scroll-region flex h-full flex-col gap-[8px] pr-[2px]"
          >
            {rows.map((row) => {
              const pct = maxTotal > 0 ? Math.max(2, (row.total / maxTotal) * 100) : 2;
              const displayName =
                dimension === "provider"
                  ? (providerNames.get(row.name) ?? row.name)
                  : dimension === "key"
                    ? (row.label ?? `${row.name.slice(0, 8)}…`)
                    : row.name;
              const okCount = Math.max(0, row.requests - row.errors);
              return (
                <div
                  key={row.name}
                  title={`${displayName} · ${formatNumber(row.requests)} hits · ${formatNumber(okCount)} ok · ${formatNumber(row.total)} tokens · ${formatUsd(row.costUsd)}`}
                  className="relative shrink-0 overflow-hidden rounded-[10px] border border-inner-border bg-surface-2"
                >
                  <div
                    aria-hidden="true"
                    className="absolute inset-0 bg-[linear-gradient(to_right,color-mix(in_srgb,var(--accent)_20%,transparent),transparent)]"
                    style={{ width: `${pct}%` }}
                  />
                  <div
                    className="relative flex items-center justify-between gap-[8px] px-[12px] py-[10px]"
                  >
                    <span
                      className="truncate font-mono tabular-nums min-w-0 flex-1 text-[11px] font-semibold"
                    >
                      {displayName}
                    </span>                    <span
                      className="font-mono tabular-nums shrink-0 text-[10px] text-text-secondary"
                    >
                      {formatNumber(row.requests)} hit · {formatNumber(okCount)} ok
                    </span>
                    <span className="shrink-0 text-[11px] font-bold text-orange">
                      {formatUsd(row.costUsd)}
                    </span>
                    <span className="shrink-0 text-[11px] font-bold text-purple">
                      {formatTokens(row.total)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardBody>
    </Card>
  );
}




function FlowNode({
  title,
  meta,
  icon,
  tone,
  last,
}: {
  readonly title: string;
  readonly meta: string;
  readonly icon: ReactNode;
  readonly tone?: string;
  readonly last?: boolean;
}): ReactNode {
  return (
    <div className="flex gap-[10px] min-w-0">
      <div className="flex flex-col items-center shrink-0">
        <span
          aria-hidden="true"
          className="grid place-items-center w-[22px] h-[22px] rounded-[999px]"
          style={{
            color: tone ?? "var(--accent)",
            background: `color-mix(in srgb, ${tone ?? "var(--accent)"} 16%, var(--surface-2))`,
          }}
        >
          {icon}
        </span>
        {last ? null : (
          <span aria-hidden="true" className="w-[2px] flex-1 min-h-[14px] bg-inner-border" />
        )}
      </div>
      <div className="min-w-0 flex-1" style={{ paddingBottom: last ? 0 : "12px" }}>
        <div className="text-[12px] font-bold">{title}</div>
        <div
          className="select-text mt-[2px] whitespace-pre-line text-[11px] text-text-secondary [overflow-wrap:anywhere] break-words"
        >
          {meta}
        </div>
      </div>
    </div>
  );
}

function RequestDetailDrawer({
  requestId,
  onClose,
}: {
  readonly requestId: string | null;
  readonly onClose: () => void;
}): ReactNode {
  const detailQuery = useUsageRequestDetail(requestId);
  const detail = detailQuery.data;
  const providerAccounts = useProviderAccounts(detail?.providerId);
  const accountLabel = (item: { readonly accountId?: string } | null | undefined): string => {
    const accountId = item?.accountId;
    if (!accountId) return "—";
    const found = (providerAccounts.data ?? []).find((account) => account.id === accountId);
    return found?.label || `${accountId.slice(0, 8)}…`;
  };
  const apiKeyName = detail?.apiKeyLabel ?? (detail?.apiKeyId ? `${detail.apiKeyId.slice(0, 8)}…` : "—");
  const isProbe = detail?.userAgent === "Cartethyia Probe";
  const displayApiKeyName = isProbe ? "Probe" : apiKeyName;
  const [copiedRequestId, setCopiedRequestId] = useState(false);
  const [copiedPayload, setCopiedPayload] = useState<PayloadKind | null>(null);
  const scheduleReset = useTrackedTimeout();
  const copyRequestId = () => {
    void navigator.clipboard?.writeText(detail?.requestId ?? "");
    setCopiedRequestId(true);
    scheduleReset(() => setCopiedRequestId(false), 1500);
  };
  const copyPayload = (kind: PayloadKind, payload: unknown) => {
    const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
    void navigator.clipboard?.writeText(text);
    setCopiedPayload(kind);
    scheduleReset(() => setCopiedPayload(null), 1500);
  };
  const payloadViews = useMemo(
    () =>
      (["request", "clientResponse", "providerRequest", "providerResponse"] as const).map((kind) => {
        const payload = detail?.payloads?.[kind];
        if (payload === undefined) return { kind, text: null, bytes: null };
        try {
          const formatted = formatPayload(payload);
          return { kind, text: formatted.text, bytes: formatted.bytes };
        } catch {
          return { kind, text: null, bytes: null };
        }
      }),
    [detail?.payloads],
  );
  const payloadView = (kind: PayloadKind) =>
    payloadViews.find((view) => view.kind === kind) ?? { kind, text: null, bytes: null };

  return (
    <Drawer open={requestId !== null} onClose={onClose} title="Request Detail">
      {detailQuery.isPending ? (
        <Stack gap="12px">
          <div className="animate-pulse h-[24px] w-[66%] rounded-[8px] bg-surface-2" />
          <div className="animate-pulse h-[96px] rounded-[10px] bg-surface-2" />
          <div className="animate-pulse h-[96px] rounded-[10px] bg-surface-2" />
        </Stack>
      ) : detailQuery.isError || !detail ? (
        <ErrorState message="Failed to load request detail." onRetry={() => void detailQuery.refetch()} />
      ) : (
        <Stack gap="12px">
          <div className="flex items-center gap-[8px] rounded-[10px] border border-inner-border bg-surface-2 px-[12px] py-[8px] min-w-0">
            <span
              className="select-text font-mono tabular-nums min-w-0 flex-1 [overflow-wrap:anywhere] break-words text-[11.5px]"
              title={detail.requestId}
            >
              request_id {detail.requestId}
            </span>
            <Button
              variant="ghost"
              size="sm"
              icon={copiedRequestId ? <Check size={12} /> : <Copy size={12} />}
              aria-label="Copy request ID"
              title="Copy request ID"
              onClick={copyRequestId}
              className="shrink-0 p-[3px]"
            />
          </div>


          {detail.errorKind ? (
            <div role="alert" className="status-callout flex flex-col gap-[4px] [overflow-wrap:anywhere] break-words" data-tone="err">
              <strong className="text-[12px]">
                {errorLabel(detail.status, detail.errorKind, detail.errorOrigin, detail.httpStatus)}
              </strong>
              <span className="font-mono tabular-nums text-text-tertiary text-[10px] [overflow-wrap:anywhere]">
                {detail.errorKind}
              </span>
            </div>
          ) : null}
          <section className="border border-inner-border rounded-[10px] overflow-hidden">
            <div className="border-b border-inner-border px-[12px] py-[10px] text-[12.5px] font-bold">
              Flow and Detail
            </div>
            <div className="flex flex-col p-[12px]">
              <FlowNode
                icon={<LogIn size={13} />}
                title="Client request in"
                meta={`Client IP : ${detail.clientIp ?? "—"}\n${detail.clientName ?? "—"} · ${detail.userAgent ?? "—"} · ${detail.surface ?? "—"} · ${detail.mode === "stream" ? "streaming" : "non-streaming"}`}
              />
              <FlowNode
                icon={<Route size={13} />}
                title="Gateway"
                meta={`${formatDuration(detail.durationMs)} total · TTFT ${formatDuration(detail.ttfbMs)} · ${formatSpeed(detail.tokensPerSec)} · ${detail.cachedTokens !== undefined ? formatNumber(detail.cachedTokens) : "—"} from cache`}
              />
              <FlowNode
                icon={<Server size={13} />}
                title={`Upstream · ${detail.providerId ?? "—"}`}
                meta={`${[accountLabel(detail), detail.model ?? "—"].filter((part) => part !== "—").join(" · ") || "—"}\nApi Key : ${displayApiKeyName}\nProxy : ${detail.proxy ?? "direct"}`}
              />
              <FlowNode
                icon={<CheckCircle2 size={13} />}
                last
                title="Response out"
                meta={`${statusCode(detail.status, detail.httpStatus).code}${payloadView("clientResponse").bytes !== null ? ` · ${formatBytes(payloadView("clientResponse").bytes)}` : ""}${detail.estimatedCost ? ` · ${formatUsd(detail.estimatedCost)}` : ""}`}
                tone={STATUS_TONE_COLOR[statusCode(detail.status, detail.httpStatus).tone]}
              />
            </div>
          </section>
          {(() => {
            const signals = detail.payloadSignals;
            const signalItems = [
              { label: "Tool calls", value: signals?.toolCalls ?? "—", icon: Wrench },
              { label: "Images", value: signals?.images ?? "—", icon: ImageIcon },
              { label: "Attachments", value: signals?.attachments ?? "—", icon: Paperclip },
            ] as const;
            return (
              <section
                aria-label="Session signals"
                className="grid grid-cols-[repeat(auto-fit,minmax(110px,1fr))] gap-[8px] border border-inner-border rounded-[10px] p-[10px] bg-surface-2"
              >
                {signalItems.map(({ label, value, icon: Icon }) => (
                  <div
                    key={label}
                    className="flex items-center gap-[7px] min-w-0 text-text-secondary"
                  >
                    <Icon size={14} aria-hidden="true" className="shrink-0 text-accent" />
                    <span className="min-w-0 [overflow-wrap:anywhere] text-[11px]">
                      {label}: <strong className="text-text-primary">{value}</strong>
                    </span>
                  </div>
                ))}
              </section>
            );
          })()}


          {(
            [
              ["request", "1. Client Request (Input)", detail.payloads?.request, LogIn],
              ["providerRequest", "2. Provider Request (Translated)", detail.payloads?.providerRequest, Route],
              ["providerResponse", "3. Provider Response (Raw)", detail.payloads?.providerResponse, Server],
              ["clientResponse", "4. Client Response (Final)", detail.payloads?.clientResponse, CheckCircle2],
            ] as const
          ).map(([kind, label, payload, Icon]) => (
            <details
              key={kind}
              className="rounded-[10px] border border-inner-border bg-surface-2 overflow-hidden"
            >
              <summary
                className="flex items-center justify-between gap-[8px] cursor-pointer px-[12px] py-[10px] text-[12px] font-bold"
              >
                <span className="inline-flex items-center gap-[7px] min-w-0">
                  <Icon size={14} className={cn("shrink-0", kind === "request" ? "text-accent" : "text-green")} />
                  <span className="[overflow-wrap:anywhere] break-words">{label}</span>
                </span>
                <span className="font-mono tabular-nums shrink-0 text-text-tertiary text-[10px] font-medium">
                  {formatBytes(payloadView(kind).bytes)}
                </span>
              </summary>
              {payload === undefined ? (
                <div
                  className="flex items-start gap-[10px] border-t border-inner-border bg-surface-1 px-[12px] py-[14px]"
                >
                  <Database size={15} className="shrink-0 text-text-tertiary mt-[1px]" />
                  <div className="min-w-0 flex flex-col gap-[3px]">
                    <strong className="text-[12px] text-text-secondary">No payload captured</strong>
                    <span className="text-[11px] text-text-tertiary [overflow-wrap:anywhere] break-words">
                      {label} is unavailable for this request.
                    </span>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex justify-end border-t border-inner-border pt-[5px] px-[8px]">
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={copiedPayload === kind ? <Check size={11} /> : <Copy size={11} />}
                      aria-label={`Copy ${label}`}
                      title={`Copy ${label}`}
                      onClick={() => copyPayload(kind, payload)}
                      className="p-[2px]"
                    />
                  </div>
                  <pre
                    className="select-text font-mono tabular-nums max-h-[256px] overflow-auto whitespace-pre-wrap [overflow-wrap:break-word] break-words m-0 border-t border-inner-border pt-[8px] px-[12px] pb-[12px] text-[10px] text-text-secondary"
                  >
                    {payloadView(kind).text}
                  </pre>
                </>
              )}
            </details>
          ))}
        </Stack>
      )}
    </Drawer>
  );
}

/**
 * Live in-flight gauge for the Requests card header: `50 in flight · 40 IPs`.
 * The two numbers answer different questions — the count is the load, the IP
 * split is its shape — so one client hammering (`5 in flight · 1 IP`) reads
 * differently from the whole fleet (`5 in flight · 5 IPs`). Green pulse while
 * the SSE stream pushes, grey with the last value when the stream drops.
 */
function InFlightPill({
  count,
  uniqueIps,
  live,
}: {
  count: number | null;
  uniqueIps: number | null;
  live: boolean;
}): ReactNode {
  const active = count ?? 0;
  const ips = uniqueIps ?? 0;
  const requestWord = active === 1 ? "request" : "requests";
  const ipWord = ips === 1 ? "IP" : "IPs";
  return (
    <span
      title={
        live
          ? `${active} ${requestWord} executing right now from ${ips} unique client ${ipWord} — all clients combined, not a summary of the table below`
          : "Live feed disconnected — last seen value"
      }
      className="inline-flex items-center gap-[6px] text-[11px] text-text-secondary whitespace-nowrap"
    >
      <span
        aria-hidden="true"
        className="w-[7px] h-[7px] rounded-[50%] shrink-0"
        style={{
          background: live ? "var(--success)" : "var(--text-tertiary)",
          boxShadow: live ? "0 0 6px var(--success)" : "none",
        }}
      />
      <span className="font-mono tabular-nums font-bold text-text-primary">
        {active} in flight · {ips} {ipWord}
      </span>
    </span>
  );
}

/**
 * Live in-flight count, held above the page body.
 *
 * The stream ticks whenever any request starts or finishes. Subscribing in the
 * page component itself re-rendered the whole page — every row, every chart —
 * on each tick, which is what made a busy Usage page feel heavy. The
 * subscription lives here instead and children pass through as a prop, so the
 * subtree stays referentially stable and a tick re-renders only the pill and
 * the one tile that read this context. One stream per open page.
 */
const InFlightContext = createContext<InFlightState>({ count: null, uniqueIps: null, live: false });

function InFlightProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const state = useInFlight();
  const value = useMemo(
    () => ({ count: state.count, uniqueIps: state.uniqueIps, live: state.live }),
    [state.count, state.uniqueIps, state.live],
  );
  return <InFlightContext.Provider value={value}>{children}</InFlightContext.Provider>;
}

/** The header pill, subscribed without dragging the page into the tick. */
function LiveInFlightPill(): ReactNode {
  const flight = useContext(InFlightContext);
  return <InFlightPill count={flight.count} uniqueIps={flight.uniqueIps} live={flight.live} />;
}

/**
 * The Requests tile. Split out because its detail line carries the live count;
 * the other tiles never change on a tick and stay in the page.
 */
function RequestsStatCard({
  pending,
  requests,
  period,
}: {
  readonly pending: boolean;
  readonly requests: number | undefined;
  readonly period: Period;
}): ReactNode {
  const flight = useContext(InFlightContext);
  return (
    <StatCard
      label="Requests"
      value={pending ? "…" : formatNumber(requests)}
      detail={`${periodLabel(period)} · ${flight.count ?? 0} in flight from ${flight.uniqueIps ?? 0} IPs`}
      icon={<Activity size={13} />}
    />
  );
}

/**
 * Scale switcher on a token card. Cards start on the exact count; each click
 * steps through the compact units from the coarsest that fits down to K and
 * then wraps back to the exact count, so the raw number and the readable
 * abbreviated form are both one click away with no dead end. Hidden when the
 * value is so small that no unit would compress it.
 */
function TokenScaleSwitch({
  label,
  value,
  scale,
  onChange,
}: {
  label: string;
  value: number | null | undefined;
  scale: number;
  onChange: (next: number) => void;
}): ReactNode {
  const auto =
    value === null || value === undefined || !Number.isFinite(value)
      ? null
      : tokenScaleIndex(value);
  if (auto === null || auto >= RAW_TOKEN_SCALE) return null;
  const next =
    scale === TOKEN_SCALE_AUTO
      ? Math.min(auto + 1, RAW_TOKEN_SCALE)
      : scale >= RAW_TOKEN_SCALE
        ? TOKEN_SCALE_AUTO
        : scale + 1;
  const currentName =
    scale === TOKEN_SCALE_AUTO
      ? TOKEN_SCALES[auto]?.suffix ?? "raw"
      : scale >= RAW_TOKEN_SCALE
        ? "raw"
        : TOKEN_SCALES[scale]?.suffix ?? "raw";
  const nextName =
    next === TOKEN_SCALE_AUTO
      ? "default unit"
      : next >= RAW_TOKEN_SCALE
        ? "exact count"
        : TOKEN_SCALES[next]?.suffix;
  return (
    <button
      type="button"
      aria-label={`${label}: currently ${currentName}, switch to ${nextName}`}
      title={`Show ${nextName}`}
      onClick={() => onChange(next)}
      className="font-mono tabular-nums inline-flex items-center gap-[4px] px-[7px] py-[3px] border border-inner-border rounded-[999px] bg-surface-2 text-text-secondary cursor-pointer text-[10px] font-bold tracking-[0.04em] leading-[1]"
    >
      <Scaling size={11} aria-hidden="true" />
      {currentName}
    </button>
  );
}


/**
 * Returns `current` with one parameter set, leaving every other parameter
 * untouched.
 *
 * The page re-renders on its own every 10s (four queries carry
 * `refetchInterval`), so a handler that built its `URLSearchParams` from the
 * `searchParams` of an earlier render could write that stale snapshot back and
 * silently revert a sibling parameter — the "breakdown tab will not switch"
 * symptom, where a click set `dim` and a concurrent update from an older
 * closure restored the previous value.
 *
 * React Router 7's `setSearchParams` accepts a functional updater that reads
 * the *current* params, so the snapshot never goes stale. This helper is the
 * pure core of that updater, kept separate so it can be tested directly.
 */
export function withParam(
  current: URLSearchParams,
  key: string,
  value: string,
): URLSearchParams {
  const next = new URLSearchParams(current);
  next.set(key, value);
  return next;
}

/**
 * Returns `set` with `key` flipped: removed when present, added when absent.
 *
 * Backs the per-panel collapse and widen toggles. Kept pure and separate from
 * the component so the transition can be tested without a DOM.
 */
export function toggleInSet<T>(set: ReadonlySet<T>, key: T): Set<T> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export default function Usage(): ReactNode {
  const [searchParams, setSearchParams] = useSearchParams();
  const period = asPeriod(searchParams.get("period"));
  const metric = asMetric(searchParams.get("metric"));
  const dimension = asDimension(searchParams.get("dim"));
  const tokenScale = asTokenScale(searchParams.get("scale"));
  // Per-panel presentation state. Deliberately not in the URL: a widened panel
  // is a local reading preference, and putting it in the query string would
  // make every toggle a navigation.
  const [widePanels, setWidePanels] = useState<ReadonlySet<PanelKey>>(() => new Set());
  const togglePanel = (
    setter: React.Dispatch<React.SetStateAction<ReadonlySet<PanelKey>>>,
    key: PanelKey,
  ) => {
    setter((prev) => toggleInSet(prev, key));
  };
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hideProviderName, setHideProviderName] = useState(() => {
    try {
      return localStorage.getItem("cartethyia:usage:hide-provider") === "true";
    } catch {
      return false;
    }
  });
  const toggleHideProviderName = () => {
    setHideProviderName((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("cartethyia:usage:hide-provider", String(next));
      } catch {}
      return next;
    });
  };
  const summaryQuery = useUsageSummary(period);
  const providersQuery = useProviders();
  const providerNames = useMemo(
    () => new Map((providersQuery.data ?? []).map((provider) => [provider.providerId, provider.label || provider.displayName])),
    [providersQuery.data],
  );
  const [requestLimit, setRequestLimit] = useState(50);
  const [requestStatusFilter, setRequestStatusFilter] = useState<number | null>(null);
  const requestsQuery = useUsageRequests(period, requestLimit, requestStatusFilter);
  /** Scroll offset of the Requests table, restored after each live refresh. */
  const requestsScrollTopRef = useRef(0);
  const [requestSortKey, setRequestSortKey] = useState<"startedAt" | "model" | "status" | "tokens" | "tps" | "ttft" | "duration">("startedAt");
  const [requestSortDirection, setRequestSortDirection] = useState<"asc" | "desc">("desc");
  const toggleRequestSort = (key: typeof requestSortKey): void => {
    setRequestSortKey((current) => {
      if (current !== key) {
        setRequestSortDirection(key === "model" ? "asc" : "desc");
        return key;
      }
      setRequestSortDirection((direction) => (direction === "asc" ? "desc" : "asc"));
      return current;
    });
  };
  const seenIdsRef = useRef<Set<string>>(new Set());
  const [newRowIds, setNewRowIds] = useState<Set<string>>(new Set());

  // Detect newly arrived requests and briefly highlight them
  useEffect(() => {
    const items = requestsQuery.data?.items ?? [];
    if (items.length === 0) return;
    const seen = seenIdsRef.current;
    if (seen.size === 0) {
      // First load: seed without highlighting
      for (const item of items) seen.add(item.requestId);
      return;
    }
    const fresh = new Set<string>();
    for (const item of items) {
      if (!seen.has(item.requestId)) {
        seen.add(item.requestId);
        fresh.add(item.requestId);
      }
    }
    if (fresh.size > 0) {
      setNewRowIds((prev) => new Set([...prev, ...fresh]));
      const timer = window.setTimeout(() => {
        setNewRowIds((current) => {
          const next = new Set(current);
          for (const id of fresh) next.delete(id);
          return next;
        });
      }, 3000);
      return () => window.clearTimeout(timer);
    }
  }, [requestsQuery.data?.items]);

  const handleTableScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    // Recorded on every scroll so a live poll that replaces the rows can put
    // the operator back where they were. `requestItems` is keyed by request id,
    // so a refetch remounts the rows and the browser resets scrollTop to 0.
    requestsScrollTopRef.current = target.scrollTop;
    if (target.scrollHeight - target.scrollTop - target.clientHeight < 40) {
      if (!requestsQuery.isFetching && requestItems.length >= requestLimit && requestLimit < 500) {
        setRequestLimit((prev) => prev + 50);
      }
    }
  };
  const summary = summaryQuery.data?.totals;
  const requestItems = useMemo(() => {
    const items = [...(requestsQuery.data?.items ?? [])];
    const direction = requestSortDirection === "asc" ? 1 : -1;
    const numeric = (value: number | undefined): number => (typeof value === "number" && Number.isFinite(value) ? value : -1);
    items.sort((left, right) => {
      switch (requestSortKey) {
        case "model":
          return `${left.providerId ?? ""}/${left.model ?? ""}`.localeCompare(`${right.providerId ?? ""}/${right.model ?? ""}`) * direction
            || left.startedAt.localeCompare(right.startedAt) * -1;
        case "status":
          return ((left.httpStatus ?? 0) - (right.httpStatus ?? 0)) * direction
            || left.startedAt.localeCompare(right.startedAt) * -1;
        case "tokens":
          return (((left.totalTokens ?? 0) - (right.totalTokens ?? 0)) * direction)
            || left.startedAt.localeCompare(right.startedAt) * -1;
        case "tps":
          return ((numeric(left.tokensPerSec) - numeric(right.tokensPerSec)) * direction)
            || left.startedAt.localeCompare(right.startedAt) * -1;
        case "ttft":
          return ((numeric(left.ttfbMs) - numeric(right.ttfbMs)) * direction)
            || left.startedAt.localeCompare(right.startedAt) * -1;
        case "duration":
          return ((numeric(left.durationMs) - numeric(right.durationMs)) * direction)
            || left.startedAt.localeCompare(right.startedAt) * -1;
        case "startedAt":
        default:
          return left.startedAt.localeCompare(right.startedAt) * direction;
      }
    });
    return items;
  }, [requestsQuery.data?.items, requestSortKey, requestSortDirection]);

  /**
   * Puts the Requests table back at the offset it was scrolled to.
   *
   * The rows are keyed by request id, so a live poll that swaps the data
   * replaces the `<tr>` elements and the browser resets the scroll container to
   * 0 — the operator is thrown back to the newest row mid-read. Restore only
   * when the row count changed, so an ordinary re-render with the same rows
   * never fights the user's own scrolling. A deliberate reset (status filter,
   * period change) clears the offset first via `resetRequestsScroll`.
   */
  useLayoutEffect(() => {
    const scroller = document.getElementById("usage-requests-scroll");
    if (scroller === null) return;
    const target = Math.min(requestsScrollTopRef.current, scroller.scrollHeight);
    scroller.scrollTop = target;
  }, [requestItems.length]);

  const resetRequestsScroll = () => {
    requestsScrollTopRef.current = 0;
  };
  const toggleRequestStatus = (status: number): void => {
    resetRequestsScroll();
    setRequestLimit(50);
    setRequestStatusFilter((current) => (current === status ? null : status));
  };

  const setParam = (key: string, value: string) => {
    setSearchParams((current) => withParam(current, key, value), { replace: true });
  };
  const setTokenScale = (next: number) => {
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current);
        if (next === DEFAULT_TOKEN_SCALE) params.delete("scale");
        else if (next === TOKEN_SCALE_AUTO) params.set("scale", "auto");
        else params.set("scale", String(next));
        return params;
      },
      { replace: true },
    );
  };

  return (
    <InFlightProvider>
      <Stack gap="16px">
      <Card>
        <CardHeader
          title="Usage"
          subtitle={usageHeadline(period, summaryQuery.isPending, summary)}
          icon={<Activity size={16} />}
        />
        <CardBody className="flex flex-col gap-[16px]">
      <div className="metric-grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))]">
        <RequestsStatCard
          pending={summaryQuery.isPending}
          requests={summary?.requests}
          period={period}
        />
        <StatCard
          label="Input tokens"
          value={summaryQuery.isPending ? "…" : tokenScaleValue(summary?.inputTokens, tokenScale)}
          detail="Prompt tokens"
          tone="accent"
          action={
            <TokenScaleSwitch
              label="Input tokens scale"
              value={summary?.inputTokens}
              scale={tokenScale}
              onChange={setTokenScale}
            />
          }
        />
        <StatCard
          label="Cached tokens"
          value={summaryQuery.isPending ? "…" : tokenScaleValue(summary?.cachedTokens, tokenScale)}
          detail={
            summaryQuery.isPending
              ? "Cache hit rate"
              : `${summary?.cacheHitRate !== undefined ? Math.round(summary.cacheHitRate * 10) / 10 : 0}% cache hit rate`
          }
          tone="purple"
          icon={<Database size={13} />}
          action={
            <TokenScaleSwitch
              label="Cached tokens scale"
              value={summary?.cachedTokens}
              scale={tokenScale}
              onChange={setTokenScale}
            />
          }
        />
        <StatCard
          label="Output tokens"
          value={summaryQuery.isPending ? "…" : tokenScaleValue(summary?.outputTokens, tokenScale)}
          detail="Completion tokens"
          icon={<ArrowUpFromLine size={13} />}
          action={
            <TokenScaleSwitch
              label="Output tokens scale"
              value={summary?.outputTokens}
              scale={tokenScale}
              onChange={setTokenScale}
            />
          }
        />
        <StatCard
          label="Est. cost"
          value={summaryQuery.isPending ? "…" : formatUsd(summary?.estimatedCostUsd)}
          // The figure is always an estimate, never an invoice. When completed
          // rows exist without a persisted price the estimate is a floor, and
          // the caption says so in plain words instead of naming the flag.
          detail="Estimated not billing"
          tone="orange"
          icon={<DollarSign size={13} />}
        />
      </div>

      <div className="two-column-grid">

        <BreakdownSnapshot
          period={period}
          dimension={dimension}
          onDimensionChange={(value) => setParam("dim", value)}
          wide={widePanels.has("breakdown")}
          onToggleWide={() => togglePanel(setWidePanels, "breakdown")}
        />
        <Card
          className={widePanels.has("traffic") ? "grid-span-full" : ""}
        >
          <CardHeader
            title="Traffic"
            subtitle={`Requests per bucket · ${periodLabel(period)}`}
            icon={<Radio size={16} />}
            leading={
              <PanelWidthToggle
                label="Traffic"
                wide={widePanels.has("traffic")}
                onToggleWide={() => togglePanel(setWidePanels, "traffic")}
              />
            }
            action={
              <Inline gap="6px" className="flex-wrap">
                <PillTabs
                  ariaLabel="Traffic metric"
                  value={metric}
                  onChange={(value) => setParam("metric", value)}
                  options={[
                    { id: "requests", label: "Requests" },
                    { id: "tokens", label: "Tokens" },
                    { id: "cached", label: "Cached" },
                  ]}
                />
                <Select
                  aria-label="Period"
                  value={period}
                  size="sm"
                  className="w-auto min-w-[92px] shrink-0 grow-0 basis-auto"
                  onValueChange={(value) => setParam("period", value)}
                  options={PERIOD_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                />
              </Inline>
            }
          />
          <CardBody>
            <ChartPanel period={period} metric={metric} />
          </CardBody>
        </Card>
      </div>

        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Requests"
          subtitle={`Most recent first · ${requestItems.length} entries · open a row to inspect`}
          subtitleAddon={
            <StatusFilters
              counts={summary?.statusCounts ?? []}
              active={requestStatusFilter}
              onToggle={toggleRequestStatus}
            />
          }
          icon={<Activity size={16} />}
          action={
            <Inline gap="12px" align="center" className="flex-wrap">
              <Button
                variant="ghost"
                size="sm"
                icon={hideProviderName ? <EyeOff size={13} /> : <Eye size={13} />}
                onClick={toggleHideProviderName}
                title={hideProviderName ? "Show real provider names" : "Mask provider names as Mysterious"}
                className="text-[11px] h-[26px] px-[8px] py-0 text-text-secondary"
              >
                {hideProviderName ? "Provider masked" : "Mask provider"}
              </Button>
              <LiveInFlightPill />
            </Inline>
          }
        />
        <CardBody className="p-0">
          {requestsQuery.isPending && requestItems.length === 0 ? (
            <div className="p-[20px]">
              <LoadingState label="Loading requests…" />
            </div>
          ) : requestsQuery.isError && requestItems.length === 0 ? (
            <div className="p-[20px]">
              <ErrorState message="Could not load recent requests." onRetry={() => void requestsQuery.refetch()} />
            </div>
          ) : requestItems.length === 0 ? (
            <div className="p-[20px]">
              <EmptyState
                title="No requests recorded for this period"
                message="Route requests through the gateway to populate the table."
                icon={<Activity size={20} />}
              />
            </div>
          ) : (
            <div id="usage-requests-scroll" className="rounded-[10px] border border-inner-border bg-surface-1">
              <DataTable
                maxHeight={445}
                onScroll={handleTableScroll}
                headers={[
                  { key: "startedAt", label: "Time", sortable: true },
                  { key: "model", label: "Provider/model", sortable: true },
                  { key: "apiKey", label: "API Key" },
                  { key: "status", label: "Status", sortable: true },
                  { key: "tokens", label: "Tokens", sortable: true },
                  { key: "tps", label: "TPS", sortable: true },
                  { key: "ttft", label: "TTFT", sortable: true },
                  { key: "duration", label: "Done", sortable: true },
                ]}
                sortKey={requestSortKey}
                sortDirection={requestSortDirection}
                onSort={(key) => toggleRequestSort(key as typeof requestSortKey)}
              >
                {requestItems.map((row) => {
                  const isNew = newRowIds.has(row.requestId);
                  const costText = row.estimatedCost === undefined ? "—" : formatUsd(row.estimatedCost);
                  // A request that failed before a candidate was leased has no
                  // serving provider, but the caller's qualified model ref still
                  // names one, so the column stays populated either way.
                  const rowProviderId = requestProviderId(row.providerId, row.model);
                  return (
                    <tr
                      key={row.requestId}
                      onClick={() => setSelectedId(row.requestId)}
                      className="cursor-pointer transition-colors"
                      style={{
                        background: isNew ? "color-mix(in srgb, var(--accent) 14%, transparent)" : undefined,
                      }}
                    >
                    <td className="text-[11.5px] text-text-tertiary whitespace-nowrap">
                      <div>{formatTime(row.startedAt)}</div>
                      <div className="text-[10.5px] mt-[1px]">{formatAgo(row.startedAt)}</div>
                    </td>
                    <td className="max-w-[210px]">
                      <div className="flex items-center gap-[6px] min-w-0">
                        <span
                          className="truncate text-[12px] font-semibold"
                          title={rowProviderId ?? "—"}
                        >
                          {hideProviderName ? "Mysterious" : rowProviderId ? (providerNames.get(rowProviderId) ?? rowProviderId) : "—"}
                        </span>
                      </div>
                      <div className="truncate subline" title={row.model ?? "—"}>
                        {hideProviderName && row.model && row.model.includes("/")
                          ? row.model.slice(row.model.indexOf("/") + 1)
                          : row.model ?? "—"}
                      </div>
                    </td>
                    <td className="max-w-[140px]">
                      <div
                        className="truncate text-[12px] font-semibold"
                        title={usageApiKeyLabel(row)}
                      >
                        {usageApiKeyLabel(row)}
                      </div>
                      <div className="truncate subline" title={usageClientLabel(row)}>
                        {usageClientLabel(row)}
                      </div>
                    </td>
                    <td className="whitespace-nowrap text-[11px]">
                      <div>
                        <span
                          className="font-mono tabular-nums inline-block min-w-[13ch] text-text-secondary"
                        >
                          {row.mode === "stream" ? "streaming" : "non-streaming"}
                        </span>
                        {" "}
                        <StatusCodeWithExplainer
                          status={row.status}
                          errorKind={row.errorKind}
                          httpStatus={row.httpStatus}
                        />
                      </div>
                      <div className="truncate subline max-w-[220px]" title={surfaceFamilyLabel(row.surface)}>
                        {surfaceFamilyLabel(row.surface)}
                      </div>
                    </td>
                    <td className="mono">
                      <div className="flex gap-[12px] justify-end">
                        <span className="inline-flex items-center gap-[4px] text-text-secondary">
                          <ArrowUp size={10} aria-label="Input tokens" /> IN {formatNumber(row.inputTokens)}
                        </span>
                        <span className="inline-flex items-center gap-[4px] text-text-secondary">
                          <ArrowDown size={10} aria-label="Output tokens" /> OUT {formatNumber(row.outputTokens)}
                        </span>
                      </div>
                      <div
                        className="flex gap-[12px] justify-end mt-[1px] text-text-tertiary"
                        title={row.estimatedCost === undefined ? "Unpriced model — no catalog rate" : undefined}
                      >
                        <span className="inline-flex items-center gap-[4px]">
                          <Database size={10} aria-label="Cached tokens" /> CACHED {formatNumber(row.cachedTokens ?? 0)}
                        </span>
                        <span className="inline-flex items-center gap-[4px]">
                          <DollarSign size={10} aria-label="Estimated cost" /> COST {costText}
                        </span>
                        {row.creditUsed !== undefined ? (
                          <span
                            className="inline-flex items-center gap-[4px]"
                            title="Provider-billed credits for this turn"
                          >
                            <Coins size={10} aria-label="Credits used" /> {formatCredit(row.creditUsed)}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="num whitespace-nowrap">
                      {formatSpeed(row.tokensPerSec)}
                    </td>
                    <td className="num">
                      <div>{formatDuration(row.ttfbMs)}</div>
                      {row.resolveMs !== undefined ? (
                        <div
                          className="text-[10.5px] mt-[1px] text-text-tertiary"
                          title="Gateway-side time before the upstream dispatch began"
                        >
                          ({formatDuration(row.resolveMs)})
                        </div>
                      ) : null}
                    </td>
                    <td className="num">
                      {formatDuration(row.durationMs)}
                    </td>
                    </tr>
                  );
                })}
              </DataTable>
            </div>
          )}
        </CardBody>
      </Card>

      <RequestDetailDrawer requestId={selectedId} onClose={() => setSelectedId(null)} />
      </Stack>
    </InFlightProvider>
  );
}
