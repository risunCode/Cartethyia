/**
 * Console Log page — live SSE stream with colored levels, auto-scroll
 * (paused when the user scrolls up), SQL-backed 200-line view cap and server-side clear (REQ-6).
 * Includes a Request History tab backed by the telemetry runtime DB.
 */

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, Search, Trash2, Wifi, WifiOff } from "lucide-react";
import { toast } from "../../lib/toast";
import { ApiError, apiDelete, apiGet } from "../../lib/api";
import { formatDuration, formatNumber, formatTime, formatTokens } from "../../lib/format";
import { qk } from "../../lib/query-keys";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/tabs";
import { ConfirmDialog } from "../../components/shared";
import { useConsoleLogStream, type ConsoleLogLevel } from "../../hooks/use-console-log-stream";

const LEVEL_COLORS: Record<ConsoleLogLevel, string> = {
  debug: "text-[var(--text-3)]",
  info: "text-[#0fa3d1] dark:text-[var(--teal)]",
  warn: "text-[var(--orange)]",
  error: "text-[var(--red)]",
};

type ConsoleLogFilter = ConsoleLogLevel | "all" | "web";
const FILTERS: ConsoleLogFilter[] = ["all", "web", "debug", "info", "warn", "error"];

// ── Request History types ────────────────────────────────────────────────────

interface RequestHistoryItem {
  requestId: string;
  endpoint: string;
  surface: string;
  apiKeyId: string | null;
  apiKeyPrefix: string | null;
  clientIp?: string | null;
  providerId: string | null;
  model: string | null;
  statusCode: number;
  errorKind: string | null;
  mode: "non_stream" | "stream";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  usageSource: string;
  clientName: string;
  clientSource: string;
  messageCount: number;
  toolCount: number;
  imageCount: number;
  tfftMs: number | null;
}

const SURFACE_SHORT: Record<string, string> = {
  "openai-chat": "chat",
  "openai-responses": "resp",
  "anthropic-messages": "msg",
  images: "img",
  native: "nat",
};

function statusTone(code: number): "ok" | "err" | "warn" | "default" {
  if (code >= 200 && code < 300) return "ok";
  if (code >= 400 && code < 500) return "warn";
  if (code >= 500) return "err";
  return "default";
}

// ── Console Log tab ──────────────────────────────────────────────────────────

const ConsoleLogRow = memo(function ConsoleLogRow({ line, isNew }: { line: { id: number; ts: string; level: ConsoleLogLevel; msg: string }; isNew: boolean }) {
  return (
    <div
      className={`grid grid-cols-1 gap-0.5 whitespace-pre-wrap break-words [overflow-wrap:anywhere] border-l-2 py-1 pl-2 sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-2 sm:py-0.5 ${isNew ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-transparent hover:bg-[var(--hover)]"}`}
      style={{ contentVisibility: "auto", containIntrinsicSize: "0 24px" }}
    >
      <span className="shrink-0 text-[var(--text-3)]">{formatTime(line.ts)}</span>
      <span className={`min-w-0 ${LEVEL_COLORS[line.level]}`}>{line.msg}</span>
    </div>
  );
});

function ConsoleLogTab() {
  const { lines, newLineIds, status, attempts } = useConsoleLogStream();
  const [filter, setFilter] = useState<ConsoleLogFilter>("all");
  const [search, setSearch] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [clearOpen, setClearOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return lines.filter((line) => {
      const isWebLog = line.scope === "http";
      if (filter === "web" ? !isWebLog : isWebLog) return false;
      if (filter !== "all" && filter !== "web" && line.level !== filter) return false;
      if (!query) return true;
      return `${line.ts} ${line.level} ${line.scope} ${line.msg}`.toLowerCase().includes(query);
    });
  }, [filter, lines, search]);

  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: 0, behavior: "auto" });
  }, [visible.length, filter, autoScroll]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atLatest = el.scrollTop < 40;
    setAutoScroll(atLatest);
  };

  const clearLogs = async () => {
    try {
      await apiDelete<{ ok: boolean }>("/console-logs");
      setClearOpen(false);
      toast.success("Console logs cleared");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "failed to clear logs");
    }
  };

  return (
    <>
      <div className="flex w-full flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-3)]">Console Logs</h3>
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <div className="relative order-last w-full sm:order-none sm:mr-auto sm:w-56">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)]" aria-hidden="true" />
            <Input
              aria-label="Search console logs"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search console logs..."
              className="h-8 pl-8 pr-2 text-xs"
            />
          </div>
          {status === "connected" ? (
            <Badge tone="ok"><Wifi size={11} className="mr-1" /> live</Badge>
          ) : status === "connecting" ? (
            <Badge tone="info">connecting...</Badge>
          ) : (
            <Badge tone="err"><WifiOff size={11} className="mr-1" /> reconnecting ({attempts})</Badge>
          )}
          <Select
            ariaLabel="Filter level"
            value={filter}
            onChange={(value) => setFilter(value as ConsoleLogFilter)}
            options={FILTERS.map((value) => ({ value, label: value === "all" ? "All logs" : value === "web" ? "Web logs" : value }))}
          />
          <Button variant="secondary" size="sm" onClick={() => setAutoScroll(true)} disabled={autoScroll} title={autoScroll ? "Following the latest log line" : "Resume following the latest log line"}>
            <ArrowDown size={13} /> {autoScroll ? "Following" : "Follow"}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setClearOpen(true)}>
            <Trash2 size={13} /> Clear
          </Button>
        </div>
      </div>

      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
        <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 font-mono text-[11.5px] leading-relaxed">
          {visible.length === 0 ? (
            <div className="flex h-full min-h-[220px] items-center justify-center">
              <p className="text-center font-sans text-sm text-[var(--text-1)]">No log lines{filter !== "all" ? ` in ${filter === "web" ? "web logs" : `the ${filter} level`}` : ""}.</p>
            </div>
          ) : (
            visible.map((line) => <ConsoleLogRow key={line.id} line={line} isNew={newLineIds.has(line.id)} />)
          )}
        </div>
        <footer className="flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-2 border-t border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2 text-[10px] text-[var(--text-3)]">
          <span className="min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap" aria-live="polite">Showing {visible.length} of {lines.length} lines{filter !== "all" ? ` · ${filter === "web" ? "web logs" : `${filter} logs`}` : ""}{search.trim() ? ` · search: "${search.trim()}"` : ""}</span>
          <span className="shrink-0">{autoScroll ? "Following latest" : "Scroll paused"}</span>
        </footer>
      </Card>

      <ConfirmDialog
        open={clearOpen}
        onClose={() => setClearOpen(false)}
        onConfirm={() => void clearLogs()}
        title="Clear Console Logs"
        message="Clear persisted runtime console logs? New lines keep streaming afterwards."
        danger
        confirmLabel="Clear"
      />
    </>
  );
}

// ── Request History tab ──────────────────────────────────────────────────────

function RequestHistoryTab() {
  const { data, isLoading, refetch } = useQuery({
    queryKey: qk.consoleLog.requestHistory,
    queryFn: () => apiGet<{ items: RequestHistoryItem[] }>("/usage/requests?limit=100"),
    refetchInterval: 10_000,
  });
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "ok" | "error">("all");

  const items = data?.items ?? [];

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return items.filter((item) => {
      if (statusFilter === "ok" && item.statusCode >= 400) return false;
      if (statusFilter === "error" && item.statusCode < 400) return false;
      if (!query) return true;
      const haystack = `${item.requestId} ${item.endpoint} ${item.surface} ${item.providerId ?? ""} ${item.model ?? ""} ${item.clientName} ${item.clientIp ?? ""} ${item.apiKeyPrefix ?? ""} ${item.errorKind ?? ""}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [items, search, statusFilter]);

  return (
    <>
      <div className="flex w-full flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-3)]">Request History</h3>
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <div className="relative order-last w-full sm:order-none sm:mr-auto sm:w-56">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)]" aria-hidden="true" />
            <Input
              aria-label="Search request history"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by IP, model, provider, key…"
              className="h-8 pl-8 pr-2 text-xs"
            />
          </div>
          <Select
            ariaLabel="Filter status"
            value={statusFilter}
            onChange={(value) => setStatusFilter(value as "all" | "ok" | "error")}
            options={[{ value: "all", label: "All" }, { value: "ok", label: "Success" }, { value: "error", label: "Errors" }]}
          />
          <Button variant="secondary" size="sm" onClick={() => void refetch()}>
            Refresh
          </Button>
        </div>
      </div>

      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-fade">
          {isLoading ? (
            <div className="flex h-full min-h-[220px] items-center justify-center">
              <p className="font-sans text-sm text-[var(--text-3)]">Loading request history…</p>
            </div>
          ) : visible.length === 0 ? (
            <div className="flex h-full min-h-[220px] items-center justify-center">
              <p className="text-center font-sans text-sm text-[var(--text-1)]">No requests{statusFilter !== "all" ? ` with status ${statusFilter}` : ""}{search.trim() ? ` matching "${search.trim()}"` : ""}.</p>
            </div>
          ) : (
            <div className="w-full">
              {/* Table header — sticky */}
              <div className="sticky top-0 z-10 grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_minmax(0,0.7fr)_minmax(0,0.7fr)] gap-2 border-b border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
                <span>Time</span>
                <span>IP / Client</span>
                <span>Provider / Model</span>
                <span>Status</span>
                <span>Tokens</span>
                <span>Duration</span>
                <span>Key</span>
              </div>
              {visible.map((item) => (
                <div
                  key={item.requestId}
                  className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_minmax(0,0.7fr)_minmax(0,0.7fr)] gap-2 border-b border-[var(--inner-border)]/50 px-3 py-2 text-[11px] transition-colors hover:bg-[var(--hover)]"
                >
                  {/* Time */}
                  <div className="min-w-0">
                    <div className="truncate text-[var(--text-2)]">{formatTime(item.startedAt)}</div>
                    <div className="truncate text-[9.5px] text-[var(--text-3)]">{SURFACE_SHORT[item.surface] ?? item.surface}{item.mode === "stream" ? " · stream" : ""}</div>
                  </div>
                  {/* IP / Client */}
                  <div className="min-w-0">
                    <div className="truncate font-mono text-[10px] text-[var(--text-2)]">{item.clientIp ?? "—"}</div>
                    <div className="truncate text-[9.5px] text-[var(--text-3)]">{item.clientName}{item.clientName !== "unknown" ? ` · ${item.clientSource}` : ""}</div>
                  </div>
                  {/* Provider / Model */}
                  <div className="min-w-0">
                    <div className="truncate text-[var(--text-2)]">{item.providerId ?? "—"}</div>
                    <div className="truncate font-mono text-[9.5px] text-[var(--text-3)]">{item.model ?? "—"}</div>
                  </div>
                  {/* Status */}
                  <div className="flex flex-col items-start gap-0.5">
                    <Badge tone={statusTone(item.statusCode)}>{item.statusCode || "—"}</Badge>
                    {item.errorKind && <span className="max-w-full truncate text-[9px] text-[var(--red)]" title={item.errorKind}>{item.errorKind}</span>}
                  </div>
                  {/* Tokens */}
                  <div className="min-w-0">
                    <div className="tabular-nums text-[var(--text-2)]">{item.totalTokens != null ? formatNumber(item.totalTokens) : "—"}</div>
                    <div className="text-[9px] text-[var(--text-3)]">
                      {item.inputTokens != null && <span>in {formatTokens(item.inputTokens)}</span>}
                      {item.cachedTokens != null && item.cachedTokens > 0 && <span> · cached {formatTokens(item.cachedTokens)}</span>}
                    </div>
                  </div>
                  {/* Duration */}
                  <div className="min-w-0">
                    <div className="tabular-nums text-[var(--text-2)]">{formatDuration(item.durationMs)}</div>
                    {item.tfftMs != null && <div className="text-[9px] text-[var(--text-3)]">ttft {formatDuration(item.tfftMs)}</div>}
                  </div>
                  {/* Key */}
                  <div className="min-w-0">
                    <span className="truncate font-mono text-[10px] text-[var(--text-3)]">{item.apiKeyPrefix ?? "—"}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <footer className="flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-2 border-t border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2 text-[10px] text-[var(--text-3)]">
          <span className="min-w-0 truncate" aria-live="polite">
            Showing {visible.length} of {items.length} requests{statusFilter !== "all" ? ` · ${statusFilter}` : ""}{search.trim() ? ` · search: "${search.trim()}"` : ""}
          </span>
          <span className="shrink-0">Auto-refresh 10s</span>
        </footer>
      </Card>
    </>
  );
}

// ── Main page — unified split view ──────────────────────────────────────────

export function ConsoleLogPage() {
  return (
    <div className="dashboard-page flex min-h-0 flex-1 flex-col gap-3 overflow-hidden pt-2 sm:pt-0">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
        <ConsoleLogTab />
        <RequestHistoryTab />
      </div>
    </div>
  );
}
