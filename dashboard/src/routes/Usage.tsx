import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Activity,
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpFromLine,
  Check,
  Copy,
  Database,
  DollarSign,
  Eye,
  EyeOff,
  Maximize2,
  Minimize2,
  Radio,
  Scaling,
  Sigma,
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
import { Button } from "../components/ui/button";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { DataTable, StatCard } from "../components/ui/layout";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state";
import { Drawer } from "../components/ui/drawer";
import { Select } from "../components/ui/select";
import { Inline } from "../components/ui/inline";
import { Stack } from "../components/ui/stack";
import { useReducedMotion } from "../lib/use-reduced-motion";
import {
  useUsageBy,
  useUsageChart,
  useUsageRequestDetail,
  useUsageRequests,
  useUsageSummary,
} from "../lib/hooks/system";
import { providerDisplayName } from "../lib/provider-names";

import { useProviderAccounts } from "../lib/hooks/providers";
import { useInFlight } from "../lib/hooks/live";
import { useTrackedTimeout } from "../lib/use-timeout";
import { USAGE_PERIODS, type UsagePeriod as Period } from "../lib/usage-periods";
import { USAGE_DIMENSIONS, type UsageDimension } from "../lib/contracts";
import {
  DEFAULT_TOKEN_SCALE,
  RAW_TOKEN_SCALE,
  TOKEN_SCALE_AUTO,
  TOKEN_SCALES,
  formatBytes,
  formatDuration,
  formatNumber,
  formatTokens,
  tokenScaleIndex,
  tokenScaleValue,
} from "../lib/format";

type Metric = "requests" | "tokens" | "cached";
/** Mirrors the backend `USAGE_DIMENSIONS`; pinned by usage-dimensions-parity.test.ts. */
type Dimension = UsageDimension;

/** Breakdown rows visible before the list scrolls; the rest scrolls inside. */
const BREAKDOWN_VISIBLE_ROWS = 5;
/** Row box (12px + 12px padding, ~17px content) plus the 8px flex gap. */
const BREAKDOWN_ROW_HEIGHT = 49;


/**
 * Payload panels shown in the request inspector. The client leg (what the
 * client sent / what Cartethyia produced / what the client actually received)
 * comes first; the provider leg (what was forwarded upstream / what the
 * upstream returned) follows so proxy and server legs are readable separately.
 * Provider internals stay redacted and bounded at the source
 * (`completeAttempt` capture), never raw secrets.
 */
type PayloadKind = "request" | "response" | "clientResponse" | "providerRequest" | "providerResponse";

const PERIOD_LABELS: Record<Period, string> = {
  "1h": "Last 1 Hour",
  "6h": "Last 6 Hours",
  "12h": "Last 12 Hours",
  "24h": "Last 24 Hours",
  "7d": "Last 7 Days",
  "30d": "Last 30 Days",
  all: "All retained",
};
const PERIOD_OPTIONS = USAGE_PERIODS.map((value) => ({ value, label: PERIOD_LABELS[value] }));

function periodLabel(period: Period): string {
  return PERIOD_LABELS[period];
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

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

/** Wire surface mapped to its compact `/surface` label for the status cell. */
function protocolLabel(surface: string | undefined): string {
  switch (surface) {
    case "chat":
      return "/chat";
    case "messages":
      return "/messages";
    case "responses":
      return "/responses";
    case "completion":
      return "/completions";
    default:
      return surface ? `/${surface}` : "—";
  }
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
    return { code: httpStatus === 200 ? "200 OK" : String(httpStatus), tone };
  }
  switch (status) {
    case "completed":
      return { code: "200 OK", tone: "ok" };
    case "failed":
      return { code: "500 ERR", tone: "err" };
    case "cancelled":
      return { code: "499", tone: "warn" };
    case "truncated":
      return { code: "502", tone: "err" };
    default:
      return { code: status, tone: "warn" };
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
  const code = httpStatus ?? statusCode(status).code;
  return errorKind ? `${code} · ${errorKind}` : String(code);
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
    <span style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        aria-expanded={open}
        aria-label={explainer}
        title={explainer}
        style={{
          fontFamily: "var(--font-mono)",
          fontWeight: 700,
          fontVariantNumeric: "tabular-nums",
          color: STATUS_TONE_COLOR[code.tone],
          background: "none",
          border: "1px solid transparent",
          borderRadius: "6px",
          padding: "0 4px",
          cursor: "pointer",
          fontSize: "inherit",
        }}
      >
        {code.code}
      </button>
      {open ? (
        <span
          role="status"
          style={{
            position: "absolute",
            zIndex: 30,
            top: "calc(100% + 6px)",
            left: 0,
            whiteSpace: "normal",
            minWidth: "220px",
            maxWidth: "280px",
            border: "1px solid var(--inner-border)",
            borderRadius: "10px",
            background: "var(--popover-bg)",
            boxShadow: "0 12px 32px rgba(0,0,0,0.16)",
            padding: "8px 10px",
            fontFamily: "var(--font-sans, system-ui)",
            fontWeight: 400,
            fontSize: "11px",
            lineHeight: 1.5,
            color: "var(--text-secondary)",
          }}
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
  return layer ? `Error ${code} · ${layer}: ${message}` : `Error ${code}: ${message}`;
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
    <div role="tablist" aria-label={ariaLabel} style={{ display: "flex", gap: "4px" }}>
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

function ChartPanel({ period, metric }: { readonly period: Period; readonly metric: Metric }): ReactNode {
  const chartQuery = useUsageChart(period);
  const reducedMotion = useReducedMotion();
  const buckets = useMemo(
    () => (chartQuery.data?.buckets ?? []).map((bucket) => ({ ...bucket, total: bucket.input + bucket.output })),
    [chartQuery.data],
  );
  const dataKey = metric === "requests" ? "requests" : metric === "cached" ? "cached" : "total";
  if (chartQuery.isPending && buckets.length === 0) {
    return <LoadingState label="Loading chart…" />;
  }
  if (chartQuery.isError && buckets.length === 0) {
    return <ErrorState message="Failed to load chart data." onRetry={() => void chartQuery.refetch()} />;
  }
  if (buckets.length === 0) {
    return (
      <EmptyState
        title="No traffic in this window"
        message="Route requests through the gateway to populate the chart."
      />
    );
  }
  return (
    <div style={{ height: "224px" }}>
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
            tickFormatter={(value: string) => value.slice(5, 16)}
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
            labelFormatter={(label) => formatDateTime(String(label))}
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
  const rows = byQuery.data?.rows ?? [];
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
      <CardBody>
        {byQuery.isPending && rows.length === 0 ? (
          <LoadingState label="Loading breakdown…" />
        ) : byQuery.isError && rows.length === 0 ? (
          <ErrorState message="Failed to load breakdown." onRetry={() => void byQuery.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState title="No usage for this period" message="Route requests to populate the breakdown." />
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "8px",
              maxHeight: `${BREAKDOWN_VISIBLE_ROWS * BREAKDOWN_ROW_HEIGHT}px`,
              overflowY: "auto",
              paddingRight: "2px",
            }}
          >
            {rows.map((row) => {
              const pct = maxTotal > 0 ? Math.max(2, (row.total / maxTotal) * 100) : 2;
              const displayName =
                dimension === "provider"
                  ? providerDisplayName(row.name)
                  : dimension === "key"
                    ? (row.label ?? `${row.name.slice(0, 8)}…`)
                    : row.name;
              const okCount = Math.max(0, row.requests - row.errors);
              return (
                <div
                  key={row.name}
                  title={`${displayName} · ${formatNumber(row.requests)} hits · ${formatNumber(okCount)} ok · ${formatNumber(row.total)} tokens · ${formatUsd(row.costUsd)}`}
                  style={{
                    position: "relative",
                    flexShrink: 0,
                    overflow: "hidden",
                    borderRadius: "10px",
                    border: "1px solid var(--inner-border)",
                    background: "var(--surface-2)",
                  }}
                >
                  <div
                    aria-hidden="true"
                    style={{
                      position: "absolute",
                      inset: 0,
                      width: `${pct}%`,
                      background:
                        "linear-gradient(to right, color-mix(in srgb, var(--accent) 20%, transparent), transparent)",
                    }}
                  />
                  <div
                    style={{
                      position: "relative",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "8px",
                      padding: "10px 12px",
                    }}
                  >
                    <span
                      className="truncate"
                      style={{ minWidth: 0, flex: 1, fontFamily: "var(--font-mono)", fontSize: "11px", fontWeight: 600 }}
                    >
                      {displayName}
                    </span>
                    <span
                      style={{
                        flexShrink: 0,
                        fontSize: "10px",
                        color: "var(--text-secondary)",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {formatNumber(row.requests)} hit · {formatNumber(okCount)} ok
                    </span>
                    <span style={{ flexShrink: 0, fontSize: "11px", fontWeight: 700, color: "var(--orange)" }}>
                      {formatUsd(row.costUsd)}
                    </span>
                    <span style={{ flexShrink: 0, fontSize: "11px", fontWeight: 700, color: "var(--purple)" }}>
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
  tone,
  last,
}: {
  readonly title: string;
  readonly meta: string;
  readonly tone?: string;
  readonly last?: boolean;
}): ReactNode {
  return (
    <div style={{ display: "flex", gap: "10px", minWidth: 0 }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
        <span
          aria-hidden="true"
          style={{
            width: "9px",
            height: "9px",
            borderRadius: "999px",
            marginTop: "4px",
            background: tone ?? "var(--accent)",
            boxShadow: `0 0 0 3px color-mix(in srgb, ${tone ?? "var(--accent)"} 18%, transparent)`,
          }}
        />
        {last ? null : (
          <span aria-hidden="true" style={{ width: "2px", flex: 1, minHeight: "14px", background: "var(--inner-border)" }} />
        )}
      </div>
      <div style={{ minWidth: 0, flex: 1, paddingBottom: last ? 0 : "12px" }}>
        <div style={{ fontSize: "12px", fontWeight: 700 }}>{title}</div>
        <div
          className="select-text"
          style={{ marginTop: "2px", whiteSpace: "pre-line", fontSize: "11px", color: "var(--text-secondary)", overflowWrap: "anywhere", wordBreak: "break-word" }}
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
    void navigator.clipboard?.writeText(JSON.stringify(payload, null, 2));
    setCopiedPayload(kind);
    scheduleReset(() => setCopiedPayload(null), 1500);
  };
  // Serialize once per payload instead of every 5s poll render: the byte
  // count and the pretty-printed <pre> both re-encode multi-MB bodies today.
  const payloadViews = useMemo(
    () => (["request", "response", "clientResponse", "providerRequest", "providerResponse"] as const).map((kind) => {
        const payload = detail?.payloads?.[kind];
        if (payload === undefined) return { kind, text: null, bytes: null };
        let text: string | null = null;
        let bytes: number | null = null;
        try {
          text = JSON.stringify(payload, null, 2);
          bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
        } catch {
          text = null;
          bytes = null;
        }
        return { kind, text, bytes };
      }),
    [detail?.payloads],
  );
  const payloadView = (kind: PayloadKind) =>
    payloadViews.find((view) => view.kind === kind) ?? { kind, text: null, bytes: null };

  return (
    <Drawer open={requestId !== null} onClose={onClose} title="Request Detail">
      {detailQuery.isPending ? (
        <Stack gap="12px">
          <div className="animate-pulse" style={{ height: "24px", width: "66%", borderRadius: "8px", background: "var(--surface-2)" }} />
          <div className="animate-pulse" style={{ height: "96px", borderRadius: "10px", background: "var(--surface-2)" }} />
          <div className="animate-pulse" style={{ height: "96px", borderRadius: "10px", background: "var(--surface-2)" }} />
        </Stack>
      ) : detailQuery.isError || !detail ? (
        <ErrorState message="Failed to load request detail." onRetry={() => void detailQuery.refetch()} />
      ) : (
        <Stack gap="12px">
          <div style={{ display: "flex", alignItems: "center", gap: "8px", borderRadius: "10px", border: "1px solid var(--inner-border)", background: "var(--surface-2)", padding: "8px 12px", minWidth: 0 }}>
            <span
              className="select-text"
              title={detail.requestId}
              style={{
                minWidth: 0,
                flex: 1,
                overflowWrap: "anywhere",
                wordBreak: "break-word",
                fontFamily: "var(--font-mono)",
                fontSize: "11.5px",
              }}
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
              style={{ flexShrink: 0, padding: "3px" }}
            />
          </div>


          {detail.errorKind ? (
            <div
              role="alert"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "4px",
                border: "1px solid color-mix(in srgb, var(--red) 35%, var(--inner-border))",
                borderRadius: "10px",
                background: "color-mix(in srgb, var(--red) 8%, var(--surface-2))",
                padding: "10px 12px",
                overflowWrap: "anywhere",
                wordBreak: "break-word",
              }}
            >
              <strong style={{ color: "var(--red)", fontSize: "12px" }}>
                {errorLabel(detail.status, detail.errorKind, detail.errorOrigin, detail.httpStatus)}
              </strong>
              <span style={{ color: "var(--text-tertiary)", fontFamily: "var(--font-mono)", fontSize: "10px", overflowWrap: "anywhere" }}>
                {detail.errorKind}
              </span>
            </div>
          ) : null}
          <section style={{ border: "1px solid var(--inner-border)", borderRadius: "10px", overflow: "hidden" }}>
            <div style={{ borderBottom: "1px solid var(--inner-border)", padding: "10px 12px", fontSize: "12.5px", fontWeight: 700 }}>
              Flow and Detail
            </div>
            <div style={{ display: "flex", flexDirection: "column", padding: "12px" }}>
              <FlowNode
                title="Client request in"
                meta={`Client IP : ${detail.clientIp ?? "—"}\n${detail.clientName ?? "—"} · ${detail.userAgent ?? "—"} · ${detail.surface ?? "—"} · ${detail.mode === "stream" ? "streaming" : "non-streaming"}`}
              />
              <FlowNode
                title="Gateway"
                meta={`${formatDuration(detail.durationMs)} total · TTFT ${formatDuration(detail.ttfbMs)} · ${formatSpeed(detail.tokensPerSec)} · ${detail.cachedTokens !== undefined ? formatNumber(detail.cachedTokens) : "—"} from cache`}
              />
              <FlowNode
                title={`Upstream · ${detail.providerId ?? "—"}`}
                meta={`${[accountLabel(detail), detail.model ?? "—"].filter((part) => part !== "—").join(" · ") || "—"}\nApi Key : ${displayApiKeyName}\nProxy : ${detail.proxy ?? "direct"}`}
              />
              <FlowNode
                last
                title="Response out"
                meta={`${statusCode(detail.status, detail.httpStatus).code}${payloadView("response").bytes !== null ? ` · ${formatBytes(payloadView("response").bytes)}` : ""}${detail.estimatedCost ? ` · ${formatUsd(detail.estimatedCost)}` : ""}`}
                tone={STATUS_TONE_COLOR[statusCode(detail.status, detail.httpStatus).tone]}
              />
            </div>
          </section>


          {(
            [
              ["request", "Client Request", detail.payloads?.request, ArrowUpFromLine],
              ["response", "Proxy → Server Response", detail.payloads?.response, ArrowDownToLine],
              ["clientResponse", "Server → Client Response", detail.payloads?.clientResponse, ArrowDownToLine],
              ["providerRequest", "Proxy → Provider Request", detail.payloads?.providerRequest, ArrowUp],
              ["providerResponse", "Provider → Proxy Response", detail.payloads?.providerResponse, ArrowDown],
            ] as const
          ).map(([kind, label, payload, Icon]) => (
            <details
              key={kind}
              style={{
                borderRadius: "10px",
                border: "1px solid var(--inner-border)",
                background: "var(--surface-2)",
                overflow: "hidden",
              }}
            >
              <summary
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "8px",
                  cursor: "pointer",
                  padding: "10px 12px",
                  fontSize: "12px",
                  fontWeight: 700,
                }}
              >
                <span style={{ display: "inline-flex", alignItems: "center", gap: "7px", minWidth: 0 }}>
                  <Icon size={14} style={{ flexShrink: 0, color: kind === "request" ? "var(--accent)" : "var(--green)" }} />
                  <span style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}>{label}</span>
                </span>
                <span style={{ flexShrink: 0, color: "var(--text-tertiary)", fontFamily: "var(--font-mono)", fontSize: "10px", fontWeight: 500 }}>
                  {formatBytes(payloadView(kind).bytes)}
                </span>
              </summary>
              {payload === undefined ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: "10px",
                    borderTop: "1px solid var(--inner-border)",
                    background: "var(--surface-1)",
                    padding: "14px 12px",
                  }}
                >
                  <Database size={15} style={{ flexShrink: 0, color: "var(--text-tertiary)", marginTop: "1px" }} />
                  <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: "3px" }}>
                    <strong style={{ fontSize: "12px", color: "var(--text-secondary)" }}>No payload captured</strong>
                    <span style={{ fontSize: "11px", color: "var(--text-tertiary)", overflowWrap: "anywhere", wordBreak: "break-word" }}>
                      {label} is unavailable for this request.
                    </span>
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ display: "flex", justifyContent: "flex-end", borderTop: "1px solid var(--inner-border)", padding: "5px 8px 0" }}>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={copiedPayload === kind ? <Check size={11} /> : <Copy size={11} />}
                      aria-label={`Copy ${label}`}
                      title={`Copy ${label}`}
                      onClick={() => copyPayload(kind, payload)}
                      style={{ padding: "2px" }}
                    />
                  </div>
                  <pre
                    className="select-text"
                    style={{
                      maxHeight: "256px",
                      overflow: "auto",
                      whiteSpace: "pre-wrap",
                      overflowWrap: "break-word",
                      wordBreak: "break-word",
                      margin: 0,
                      borderTop: "1px solid var(--inner-border)",
                      padding: "8px 12px 12px",
                      fontFamily: "var(--font-mono)",
                      fontSize: "10px",
                      color: "var(--text-secondary)",
                    }}
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

/** Live in-flight gauge for the Requests card header. Green pulse while the
 * SSE stream pushes, grey with the last value when the stream drops. */
function InFlightPill({ count, live }: { count: number | null; live: boolean }): ReactNode {
  return (
    <span
      title={live ? "Live requests currently executing on the gateway" : "Live feed disconnected — last seen value"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        fontSize: "11px",
        color: "var(--text-secondary)",
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--text-primary)" }}>
        {count ?? 0}
      </span>
      <span>in flight request</span>
    </span>
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
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        padding: "3px 7px",
        border: "1px solid var(--inner-border)",
        borderRadius: "999px",
        background: "var(--surface-2)",
        color: "var(--text-secondary)",
        cursor: "pointer",
        fontFamily: "var(--font-mono)",
        fontSize: "10px",
        fontWeight: 700,
        letterSpacing: "0.04em",
        lineHeight: 1,
      }}
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
  const [requestLimit, setRequestLimit] = useState(50);
  const [requestStatusFilter, setRequestStatusFilter] = useState<number | null>(null);
  const requestsQuery = useUsageRequests(period, requestLimit, requestStatusFilter);
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
    if (target.scrollHeight - target.scrollTop - target.clientHeight < 40) {
      if (!requestsQuery.isFetching && requestItems.length >= requestLimit && requestLimit < 500) {
        setRequestLimit((prev) => prev + 50);
      }
    }
  };
  const flight = useInFlight();
  const summary = summaryQuery.data?.totals;
  const requestItems = requestsQuery.data?.items ?? [];
  const countForStatus = (status: number): number =>
    summary?.statusCounts.find((item) => item.status === status)?.count ?? 0;
  const toggleRequestStatus = (status: number): void => {
    setRequestLimit(50);
    setRequestStatusFilter((current) => (current === status ? null : status));
  };

  // Live data without a refresh button: whenever the in-flight count settles
  // (a request started or finished), re-pull the summary and the table after
  // a short debounce so fresh completions appear on their own.
  const lastFlight = useRef<{ count: number | null; live: boolean }>({ count: null, live: false });
  useEffect(() => {
    const previous = lastFlight.current;
    lastFlight.current = { count: flight.count, live: flight.live };
    if (flight.count === null) return;
    if (previous.count === flight.count && previous.live === flight.live) return;
    const timer = window.setTimeout(() => {
      void Promise.all([summaryQuery.refetch(), requestsQuery.refetch()]).catch(() => undefined);
    }, 750);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flight.count, flight.live]);

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
    <Stack gap="16px">
      <div className="metric-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
        <StatCard
          label="Requests"
          value={summaryQuery.isPending ? "…" : formatNumber(summary?.requests)}
          detail={`${periodLabel(period)} · ${flight.count ?? 0} in flight`}
          icon={<Activity size={13} />}
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
          detail={summary?.partial ? "Estimated · partial" : "Estimated, not billing"}
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
              <Inline gap="6px" style={{ flexWrap: "wrap" }}>
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
                  style={{ width: "auto", minWidth: "92px", flex: "0 0 auto" }}
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

      <Card>
        <CardHeader
          title="Requests"
          subtitle={`Most recent first · ${requestItems.length} entries · updates live · open a row to inspect`}
          subtitleAddon={
            <div className="usage-status-filters" role="group" aria-label="Filter requests by HTTP status">
              {[
                { status: 200, label: "200 OK" },
                { status: 499, label: "499" },
                { status: 503, label: "503" },
              ]
                .filter(({ status }) => countForStatus(status) > 0)
                .map(({ status, label }) => (
                  <button
                    key={status}
                    type="button"
                    className="usage-status-filter"
                    data-status={status}
                    aria-pressed={requestStatusFilter === status}
                    aria-label={`Filter ${label}: ${formatNumber(countForStatus(status))} requests`}
                    title={`Show ${formatNumber(countForStatus(status))} requests with HTTP ${status}`}
                    onClick={() => toggleRequestStatus(status)}
                  >
                    <span>{label}</span>
                    <span className="usage-status-filter-count">
                      {formatNumber(countForStatus(status))}
                    </span>
                  </button>
                ))}
            </div>
          }
          icon={<Activity size={16} />}
          action={
            <Inline gap="12px" align="center">
              <Button
                variant="ghost"
                size="sm"
                icon={hideProviderName ? <EyeOff size={13} /> : <Eye size={13} />}
                onClick={toggleHideProviderName}
                title={hideProviderName ? "Show real provider names" : "Mask provider names as Mysterious"}
                style={{ fontSize: "11px", height: "26px", padding: "0 8px", color: "var(--text-secondary)" }}
              >
                {hideProviderName ? "Masked" : "Mask"}
              </Button>
              <InFlightPill count={flight.count} live={flight.live} />
            </Inline>
          }
        />
        <CardBody style={{ padding: 0 }}>
          {requestsQuery.isPending && requestItems.length === 0 ? (
            <div style={{ padding: "20px" }}>
              <LoadingState label="Loading requests…" />
            </div>
          ) : requestsQuery.isError && requestItems.length === 0 ? (
            <div style={{ padding: "20px" }}>
              <ErrorState message="Could not load recent requests." onRetry={() => void requestsQuery.refetch()} />
            </div>
          ) : requestItems.length === 0 ? (
            <div style={{ padding: "20px" }}>
              <EmptyState
                title="No requests recorded for this period"
                message="Route requests through the gateway to populate the table."
                icon={<Activity size={20} />}
              />
            </div>
          ) : (
            <div
              onScroll={handleTableScroll}
              style={{ maxHeight: "445px", overflow: "auto", borderRadius: "10px", border: "1px solid var(--inner-border)" }}
            >
              <DataTable headers={["Time", "Provider/model", "Status", "Tokens", "Cache (of input)", "TTFT", "tps", "Dur"]}>
                {requestItems.map((row) => {
                  const isNew = newRowIds.has(row.requestId);
                  return (
                    <tr
                      key={row.requestId}
                      onClick={() => setSelectedId(row.requestId)}
                      style={{
                        cursor: "pointer",
                        background: isNew ? "color-mix(in srgb, var(--accent) 14%, transparent)" : undefined,
                        transition: "background-color var(--dur-macro) var(--ease-spring)",
                      }}
                    >
                    <td style={{ fontSize: "11.5px", color: "var(--text-tertiary)", whiteSpace: "nowrap" }}>
                      {formatTime(row.startedAt)}
                    </td>
                    <td style={{ maxWidth: "210px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "6px", minWidth: 0 }}>
                        <span
                          className="truncate"
                          title={row.providerId ?? "—"}
                          style={{ fontSize: "12px", fontWeight: 600 }}
                        >
                          {hideProviderName ? "Mysterious" : row.providerId ? providerDisplayName(row.providerId) : "—"}
                        </span>
                      </div>
                      <div
                        className="truncate"
                        title={row.model ?? "—"}
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: "11px",
                          color: "var(--text-tertiary)",
                          marginTop: "1px",
                        }}
                      >
                        {hideProviderName && row.model && row.model.includes("/")
                          ? row.model.slice(row.model.indexOf("/") + 1)
                          : row.model ?? "—"}
                      </div>
                    </td>
                    <td style={{ whiteSpace: "nowrap", fontSize: "11px" }}>
                      <div>
                        <span
                          style={{
                            display: "inline-block",
                            minWidth: "13ch",
                            fontFamily: "var(--font-mono)",
                            color: "var(--text-secondary)",
                          }}
                        >
                          {row.mode === "stream" ? "streaming" : "non-streaming"}
                        </span>
                        {" - "}
                        <StatusCodeWithExplainer
                          status={row.status}
                          errorKind={row.errorKind}
                          httpStatus={row.httpStatus}
                        />
                      </div>
                      <div
                        className="truncate"
                        title={row.userAgent ?? row.clientName ?? "—"}
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: "11px",
                          color: "var(--text-tertiary)",
                          marginTop: "1px",
                          maxWidth: "220px",
                        }}
                      >
                        {protocolLabel(row.surface)} - {row.clientName ?? row.userAgent ?? "—"}
                      </div>
                    </td>
                    <td style={{ fontFamily: "var(--font-mono)", fontSize: "11px", whiteSpace: "nowrap", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: "3px", color: "var(--text-secondary)" }}>
                        <ArrowUp size={10} aria-label="Input tokens" /> {formatNumber(row.inputTokens)}
                      </span>
                      {" "}
                      <span style={{ display: "inline-flex", alignItems: "center", gap: "3px", color: "var(--text-secondary)" }}>
                        <ArrowDown size={10} aria-label="Output tokens" /> {formatNumber(row.outputTokens)}
                      </span>
                      {" "}
                      <span style={{ display: "inline-flex", alignItems: "center", gap: "3px", fontWeight: 700 }}>
                        <Sigma size={10} aria-label="Total tokens" /> {formatNumber(row.totalTokens)}
                      </span>
                    </td>
                    <td style={{ fontFamily: "var(--font-mono)", fontSize: "11.5px", textAlign: "right", color: "var(--text-secondary)" }}>
                      {row.cachedTokens !== undefined && row.cachedTokens > 0
                        ? `${formatNumber(row.cachedTokens)} / ${formatNumber(row.inputTokens)}`
                        : formatNumber(row.cachedTokens ?? 0)}
                    </td>
                    <td style={{ fontFamily: "var(--font-mono)", fontSize: "11.5px", textAlign: "right", color: "var(--text-secondary)" }}>
                      {formatDuration(row.ttfbMs)}
                    </td>
                    <td style={{ fontFamily: "var(--font-mono)", fontSize: "11.5px", textAlign: "right", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                      {formatSpeed(row.tokensPerSec)}
                    </td>
                    <td style={{ fontFamily: "var(--font-mono)", fontSize: "11.5px", textAlign: "right", color: "var(--text-secondary)" }}>
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
  );
}
