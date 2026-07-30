import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Activity, ArrowDownToLine, ArrowUpFromLine, Database, DollarSign, Radio, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
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
import { apiGet } from "../../lib/api";
import { formatDuration, formatNumber, formatTime, formatTokens, formatUsd } from "../../lib/format";
import { useInFlightStream } from "../../lib/hooks/use-inflight-stream";
import { staggerClass } from "../../lib/motion";
import { Badge, Skeleton } from "../../components/ui/badge";
import { Card, CardHeader } from "../../components/ui/card";
import { Drawer } from "../../components/ui/drawer";
import { Input } from "../../components/ui/input";
import { Select, Tabs } from "../../components/ui/tabs";
import { cn } from "../../lib/cn";

type Period = "1h" | "24h" | "7d" | "30d";
type Metric = "requests" | "tokens" | "cached";
type Dimension = "model" | "provider" | "key";

interface Summary {
  requests: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  errors: number;
  avgDurationMs: number;
  estimatedCostUsd: number;
  /** True when at least one request in this period used a provider/model with no published rate card, so estimatedCostUsd under-counts. */
  partial: boolean;
}

interface ChartBucket {
  t: string;
  requests: number;
  input: number;
  cached: number;
  output: number;
}

interface ByRow {
  name: string;
  requests: number;
  input: number;
  output: number;
  cached: number;
  total: number;
}

interface RequestRow {
  id: number;
  trace_id: string;
  endpoint: string;
  surface: string;
  api_key_prefix: string | null;
  provider: string | null;
  model: string | null;
  status: number | null;
  error_kind: string | null;
  stream: number | boolean;
  started_at: string;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  total_tokens: number | null;
}

interface RequestDetail extends RequestRow {
  traceId: string;
  durationMs: number | null;
  trace: {
    traceId: string;
    startedAt: string;
    finishedAt: string;
    status: number;
    durationMs: number;
    payload: Record<string, unknown> | null;
  } | null;
  finishedAt: string | null;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    cachedTokens: number | null;
    cacheWriteTokens: number | null;
    reasoningTokens: number | null;
    totalTokens: number | null;
    source: string;
  };
  meta: Record<string, unknown>;
  detail: Record<string, unknown> | null;
  toolCalls: Record<string, unknown>[];
  assets: Record<string, unknown>[];
}

/** Headline metrics for the selected period. Usage owns these / the Overview no longer duplicates them. */
const STAT_CARDS = [
  { key: "requests", label: "Requests", icon: Activity, color: "#0a84ff", format: formatNumber },
  { key: "inputTokens", label: "Input Tokens", icon: ArrowDownToLine, color: "#64d2ff", format: formatTokens },
  { key: "cachedTokens", label: "Cached Tokens", icon: Database, color: "#bf5af2", format: formatTokens },
  { key: "outputTokens", label: "Output Tokens", icon: ArrowUpFromLine, color: "#30d158", format: formatTokens },
  { key: "errors", label: "Errors", icon: TriangleAlert, color: "#ff453a", format: formatNumber },
  { key: "estimatedCostUsd", label: "Est. Cost", icon: DollarSign, color: "#ffd60a", format: formatUsd },
] as const satisfies readonly {
  key: keyof Summary;
  label: string;
  icon: typeof Activity;
  color: string;
  format: (value: number | null) => string;
}[];

const PERIOD_OPTIONS = [
  { value: "1h", label: "1h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
];

function statusTone(status: number | null): "ok" | "err" | "warn" {
  if (status === null) return "warn";
  if (status >= 400) return "err";
  return "ok";
}

function parsePayload(value: unknown): unknown {
  let parsed = value;
  // Stored payloads can contain a JSON body encoded as a JSON string.
  for (let depth = 0; depth < 3 && typeof parsed === "string"; depth += 1) {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      break;
    }
  }
  return parsed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function payloadText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return String(value);
  }
}

function PayloadCode({ value, maxHeight = "max-h-64" }: { value: unknown; maxHeight?: string }) {
  return (
    <div className={cn("min-w-0 overflow-auto rounded-xl border border-[var(--inner-border)] bg-[var(--kbd-bg)]", maxHeight)}>
      <pre className="w-max min-w-full whitespace-pre p-3 font-mono text-[10px] leading-relaxed text-[var(--text-1)]">{payloadText(value)}</pre>
    </div>
  );
}

function ChartPanel({ period, metric }: { period: Period; metric: Metric }) {
  const { data, isLoading } = useQuery({
    queryKey: ["usage-chart", period, metric],
    queryFn: () => apiGet<{ buckets: ChartBucket[] }>(`/usage/chart?period=${period}&metric=${metric}`),
  });
  if (isLoading) return <Skeleton className="h-56" />;
  const buckets = data?.buckets ?? [];
  const value = (bucket: ChartBucket) =>
    metric === "requests" ? bucket.requests : metric === "cached" ? bucket.cached : bucket.input + bucket.output;

  return (
    <div className="h-56">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={buckets} margin={{ top: 8, right: 8, left: -14, bottom: 0 }}>
          <defs>
            <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0a84ff" stopOpacity={0.45} />
              <stop offset="100%" stopColor="#0a84ff" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--inner-border)" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="t"
            tick={{ fontSize: 10, fill: "var(--text-3)" }}
            tickFormatter={(value: string) => value.slice(5, 16)}
            axisLine={false}
            tickLine={false}
            minTickGap={28}
          />
          <YAxis tick={{ fontSize: 10, fill: "var(--text-3)" }} axisLine={false} tickLine={false} tickFormatter={(v: number) => formatTokens(v)} />
          <Tooltip
            contentStyle={{
              background: "var(--glass-bg-2)",
              border: "1px solid var(--glass-border-2)",
              borderRadius: 12,
              fontSize: 12,
              backdropFilter: "blur(20px)",
              color: "var(--text-1)",
            }}
            labelStyle={{ color: "var(--text-2)", fontSize: 11 }}
            formatter={(value: number | string) => [formatNumber(Number(value)), metric]}
          />
          <Area
            type="monotone"
            dataKey={value as never}
            stroke="#0a84ff"
            strokeWidth={2}
            fill="url(#chartFill)"
            isAnimationActive
            animationDuration={600}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function ByDimension({ period, dimension }: { period: Period; dimension: Dimension }) {
  const { data, isLoading } = useQuery({
    queryKey: ["usage-by", period, dimension],
    queryFn: () => apiGet<{ rows: ByRow[] }>(`/usage/by-${dimension}?period=${period}`),
  });
  if (isLoading) return <Skeleton className="h-40" />;
  const rows = data?.rows ?? [];
  const max = Math.max(1, ...rows.map((row) => row.total));
  if (rows.length === 0) return <p className="py-8 text-center text-sm text-[var(--text-3)]">No data for this period.</p>;
  return (
    <div className="flex flex-col">
      {rows.slice(0, 5).map((row, index) => (
        <div key={row.name} {...staggerClass(index)} className="border-b border-[var(--inner-border)] py-2.5 last:border-0">
          <div className="flex items-center justify-between text-xs">
            <span className="truncate font-mono text-[11.5px] font-semibold">{row.name}</span>
            <span className="tabular-nums text-[var(--text-2)]">{formatTokens(row.total)}</span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--track)]">
            <motion.div
              className="h-full rounded-full bg-gradient-to-r from-[#0a84ff] to-[#64d2ff]"
              initial={{ width: 0 }}
              animate={{ width: `${Math.max(2, (row.total / max) * 100)}%` }}
              transition={{ duration: 0.6, ease: [0.2, 0.8, 0.2, 1] }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function DetailDrawer({ id, onClose }: { id: number | null; onClose: () => void }) {
  const { data } = useQuery({
    queryKey: ["usage-detail", id],
    queryFn: () => apiGet<RequestDetail>(`/usage/requests/${id}`),
    enabled: id !== null,
  });
  const incoming = parsePayload(data?.detail?.redacted_request);
  const completionPayload = parsePayload(data?.detail?.redacted_response);
  const incomingRecord = asRecord(incoming);
  const incomingMessages = Array.isArray(incomingRecord?.messages)
    ? incomingRecord.messages
    : Array.isArray(incomingRecord?.input) ? incomingRecord.input : [];
  const resultRecord = asRecord(completionPayload);
  const completion = Array.isArray(resultRecord?.choices) ? resultRecord.choices[0] : resultRecord;
  const completionRecord = asRecord(completion);
  const completionMessage = asRecord(completionRecord?.message) ?? completionRecord;
  const completionContent = completionMessage?.content ?? completionRecord?.content ?? null;
  const completionReasoning = completionMessage?.reasoning_content ?? completionMessage?.reasoning ?? resultRecord?.reasoning ?? null;
  const completionTools = Array.isArray(completionMessage?.tool_calls) ? completionMessage.tool_calls : [];
  return (
    <Drawer open={id !== null} onClose={onClose} title="Request Detail">
      {!data ? (
        <div className="space-y-3">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : (
        <div className="space-y-4 text-sm">
          <div>
            <div className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Trace ID</div>
            <div className="mt-1 break-all font-mono text-xs">{data.traceId}</div>
            <div className="mt-1.5">{data.trace ? <Badge tone="info">JSONL trace matched</Badge> : <Badge tone="warn">trace log unavailable</Badge>}</div>
          </div>
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
              <div className="mt-1">{data.provider ?? "—"}</div>
            </div>
            <div>
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Model</div>
              <div className="mt-1 font-mono text-xs">{data.model ?? "—"}</div>
            </div>
            <div>
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Status</div>
              <div className="mt-1">
                <Badge tone={statusTone(data.status)}>{data.status ?? "—"}</Badge>
                {Boolean(data.stream) && <Badge tone="info" className="ml-1.5">stream</Badge>}
              </div>
            </div>
            <div>
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Duration</div>
              <div className="mt-1 tabular-nums">{formatDuration(data.durationMs)}</div>
            </div>
          </div>

          <div>
            <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Tokens</div>
            <div className="grid grid-cols-3 gap-2 rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-3 text-center tabular-nums">
              <div>
                <div className="text-base font-bold">{formatNumber(data.usage.inputTokens)}</div>
                <div className="text-[10.5px] text-[var(--text-3)]">input</div>
              </div>
              <div>
                <div className="text-base font-bold">{formatNumber(data.usage.cachedTokens)}</div>
                <div className="text-[10.5px] text-[var(--text-3)]">cached</div>
              </div>
              <div>
                <div className="text-base font-bold">{formatNumber(data.usage.outputTokens)}</div>
                <div className="text-[10.5px] text-[var(--text-3)]">output</div>
              </div>
            </div>
            <p className="mt-1.5 text-[10.5px] text-[var(--text-3)]">usage source: {data.usage.source}</p>
          </div>

          {data.detail && (
            <>
              <div>
                <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Payload meta</div>
                <div className="space-y-1 rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-3 text-xs">
                  <div>messages: {String(data.detail.message_count ?? "—")}</div>
                  <div>images: {String(data.detail.image_count ?? "—")}</div>
                  {data.detail.tool_names ? <div>tools: {String(data.detail.tool_names)}</div> : null}
                  <div className="break-all">sha256: {String(data.detail.payload_sha256 ?? "—")}</div>
                </div>
              </div>

              <div>
                <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Incoming chat ({incomingMessages.length})</div>
                {incomingMessages.length > 0 ? (
                  <div className="max-h-56 space-y-1.5 overflow-auto rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-3">
                    {incomingMessages.map((message, index) => {
                      const item = asRecord(message);
                      return (
                        <div key={index} className="min-w-0 rounded-lg bg-[var(--kbd-bg)] px-2.5 py-1.5">
                          <span className="mr-1.5 text-[10px] font-semibold uppercase text-[var(--accent)]">{String(item?.role ?? item?.type ?? "message")}</span>
                          <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[10px] text-[var(--text-1)]">{payloadText(item?.content ?? message)}</pre>
                        </div>
                      );
                    })}
                  </div>
                ) : <PayloadCode value={incoming} maxHeight="max-h-56" />}
              </div>

              <div>
                <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Completion</div>
                <div className="space-y-2 rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-3">
                  {completionReasoning !== null && (
                    <div>
                      <div className="mb-1 text-[10px] font-semibold uppercase text-[var(--teal)]">Reasoning</div>
                      <PayloadCode value={completionReasoning} maxHeight="max-h-32" />
                    </div>
                  )}
                  {completionContent !== null && (
                    <div>
                      <div className="mb-1 text-[10px] font-semibold uppercase text-[var(--accent)]">Assistant</div>
                      <PayloadCode value={completionContent} maxHeight="max-h-48" />
                    </div>
                  )}
                  {completionTools.length > 0 && (
                    <div>
                      <div className="mb-1 text-[10px] font-semibold uppercase text-[var(--orange)]">Tool calls ({completionTools.length})</div>
                      <PayloadCode value={completionTools} maxHeight="max-h-40" />
                    </div>
                  )}
                  {completionContent === null && completionReasoning === null && completionTools.length === 0 && <PayloadCode value={completionPayload} maxHeight="max-h-48" />}
                </div>
              </div>

              <div>
                <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-3)]">End result</div>
                <PayloadCode value={data.trace ?? {
                  traceId: data.traceId,
                  endpoint: data.endpoint,
                  status: data.status,
                  errorKind: data.error_kind,
                  durationMs: data.durationMs,
                  usage: data.usage,
                }} maxHeight="max-h-72" />
              </div>
            </>
          )}

          {data.toolCalls.length > 0 && (
            <div>
              <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Tool calls</div>
              <div className="space-y-1">
                {data.toolCalls.map((call, index) => (
                  <div key={index} className="flex items-center justify-between rounded-lg border border-[var(--inner-border)] bg-[var(--hover)] px-2.5 py-1.5 text-xs">
                    <span className="font-mono">{String(call.name)}</span>
                    <span className="tabular-nums text-[var(--text-3)]">{formatNumber(Number(call.bytes ?? 0))} B</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {data.error_kind && (
            <div>
              <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Error</div>
              <Badge tone="err">{data.error_kind}</Badge>
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}

export function UsagePage() {
  const inFlight = useInFlightStream();
  const [searchParams, setSearchParams] = useSearchParams();
  const period = (searchParams.get("period") ?? "24h") as Period;
  const metric = (searchParams.get("metric") ?? "requests") as Metric;
  const dimension = (searchParams.get("dim") ?? "model") as Dimension;
  const [live, setLive] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const filters = useMemo(
    () => ({
      provider: searchParams.get("provider") ?? "",
      model: searchParams.get("model") ?? "",
      key: searchParams.get("key") ?? "",
      status: searchParams.get("status") ?? "",
      stream: searchParams.get("stream") ?? "",
      q: searchParams.get("q") ?? "",
    }),
    [searchParams]
  );

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };

  const summaryQuery = useQuery({
    queryKey: ["usage-summary", period],
    queryFn: () => apiGet<Summary>(`/usage/summary?period=${period}`),
    refetchInterval: live ? 10_000 : false,
  });

  const requestsQuery = useQuery({
    queryKey: ["usage-requests", filters],
    queryFn: () => {
      const params = new URLSearchParams({ limit: "10" });
      for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
      return apiGet<{ items: RequestRow[] }>(`/usage/requests?${params.toString()}`);
    },
    refetchInterval: live ? 5_000 : false,
  });

  const summary = summaryQuery.data;
  const requestItems = requestsQuery.data?.items ?? [];

  return (
    <>
      {/* Stat cards + selectors — pinned below appbar */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {STAT_CARDS.map((card, index) => (
          <div key={card.label} {...staggerClass(index)} className="glass rounded-2xl p-3.5 transition-transform duration-200 hover:-translate-y-0.5">
            <span className="mb-2.5 grid h-8 w-8 place-items-center rounded-[10px]" style={{ background: `${card.color}24`, color: card.color }}>
              <card.icon size={15} />
            </span>
            <div className="text-lg font-bold leading-none tabular-nums">
              {summaryQuery.isLoading ? "…" : card.format(summary?.[card.key] ?? null)}
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-[11px] text-[var(--text-2)]">
              {card.label}
              {card.key === "requests" && inFlight > 0 && (
                <span className="inline-flex items-center gap-0.5 rounded-full bg-[var(--accent-soft)] px-1.5 py-0.5 text-[9.5px] font-semibold text-[var(--accent)]">
                  <span className="size-1.5 animate-pulse rounded-full bg-[var(--accent)]" />+{inFlight} in flight
                </span>
              )}
              {card.key === "estimatedCostUsd" && summary?.partial && (
                <span title="Some requests used a provider with no published rate card and aren't included" className="text-[9.5px] font-semibold text-[#ffd60a]">
                  partial
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Traffic + Breakdown side-by-side */}
      <section className="grid grid-cols-1 gap-3.5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Traffic" icon={Radio} sub={`Requests per bucket · ${period}`}>
            <div className="flex items-center gap-2">
              <Tabs
                tabs={[
                  { id: "requests", label: "Requests" },
                  { id: "tokens", label: "Tokens" },
                  { id: "cached", label: "Cached" },
                ]}
                value={metric}
                onChange={(value) => setParam("metric", value)}
              />
              <Select ariaLabel="Period" value={period} onChange={(value) => setParam("period", value)} options={PERIOD_OPTIONS} />
            </div>
          </CardHeader>
          <ChartPanel period={period} metric={metric} />
        </Card>

        <Card className="min-w-0">
          <CardHeader title="Breakdown" icon={Database} iconColor="#bf5af2" sub="Total tokens · top entries">
            <Tabs
              tabs={[
                { id: "model", label: "Model" },
                { id: "provider", label: "Provider" },
                { id: "key", label: "Key" },
              ]}
              value={dimension}
              onChange={(value) => setParam("dim", value)}
            />
          </CardHeader>
          <div className="max-h-[320px] overflow-y-auto">
            <ByDimension period={period} dimension={dimension} />
          </div>
        </Card>
      </section>

      <Card>
        <CardHeader title="Requests" icon={Activity} sub="Click a row for full detail">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setLive((value) => !value)}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-all active:scale-95",
                live
                  ? "border-transparent bg-[rgba(48,209,88,0.14)] text-[#1fa84a] dark:text-[var(--green)]"
                  : "border-[var(--inner-border)] bg-[var(--hover)] text-[var(--text-2)]"
              )}
            >
              <Radio size={11} className={live ? "animate-pulse" : undefined} />
              {live ? "Live" : "Paused"}
            </button>
          </div>
        </CardHeader>

        <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-6">
          <Input placeholder="Trace ID…" value={filters.q} onChange={(e) => setParam("q", e.target.value)} />
          <Input placeholder="provider" value={filters.provider} onChange={(e) => setParam("provider", e.target.value)} />
          <Input placeholder="model" value={filters.model} onChange={(e) => setParam("model", e.target.value)} />
          <Input placeholder="key prefix" value={filters.key} onChange={(e) => setParam("key", e.target.value)} />
          <Input placeholder="status" value={filters.status} onChange={(e) => setParam("status", e.target.value)} />
          <Select
            ariaLabel="Stream filter"
            value={filters.stream}
            onChange={(value) => setParam("stream", value)}
            options={[
              { value: "", label: "any mode" },
              { value: "true", label: "stream" },
              { value: "false", label: "json" },
            ]}
          />
        </div>

        <div className="max-h-[420px] overflow-x-auto overflow-y-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-[var(--inner-border)] text-left text-[10.5px] uppercase tracking-wider text-[var(--text-3)]">
                <th className="px-3 py-2 font-semibold">Time</th>
                <th className="px-3 py-2 font-semibold">Key</th>
                <th className="px-3 py-2 font-semibold">Model</th>
                <th className="px-3 py-2 font-semibold">Mode</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2 text-right font-semibold">Tokens</th>
                <th className="px-3 py-2 text-right font-semibold">Dur</th>
              </tr>
            </thead>
            <tbody>
              {requestsQuery.isLoading && (
                <tr>
                  <td colSpan={7} className="px-3 py-6">
                    <Skeleton className="h-5" />
                  </td>
                </tr>
              )}
              {!requestsQuery.isLoading && requestItems.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-[var(--text-3)]">
                    No requests match the current filters.
                  </td>
                </tr>
              )}
              {requestItems.map((row) => (
                <tr
                  key={row.id}
                  onClick={() => setSelectedId(row.id)}
                  className="cursor-pointer border-b border-[var(--inner-border)] transition-colors last:border-0 hover:bg-[var(--hover)]"
                >
                  <td className="px-3 py-2.5 tabular-nums text-[var(--text-2)]">{formatTime(row.started_at)}</td>
                  <td className="px-3 py-2.5 font-mono">{row.api_key_prefix ?? "anon"}</td>
                  <td className="px-3 py-2.5 font-mono">{row.model ?? "—"}</td>
                  <td className="px-3 py-2.5">
                    <Badge tone={row.stream === 1 ? "info" : "default"}>{row.stream === 1 ? "stream" : "json"}</Badge>
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge tone={statusTone(row.status)}>{row.status ?? "—"}</Badge>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{formatNumber(row.total_tokens)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-[var(--text-2)]">{formatDuration(row.duration_ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex items-center justify-between">
          <span className="text-[11px] text-[var(--text-3)]">{requestItems.length} rows</span>

        </div>
      </Card>

      <DetailDrawer id={selectedId} onClose={() => setSelectedId(null)} />
    </>
  );
}

