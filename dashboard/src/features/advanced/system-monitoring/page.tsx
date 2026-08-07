/**
 * System Monitoring page — per-request/endpoint monitoring, IP tracking,
 * advanced console logs, and IP ban management.
 *
 * Three tabs:
 *  1. Request Monitor  — live request feed with IP, status, provider, model
 *  2. IP Monitor        — per-IP request summary with ban/unban controls
 *  3. Console Logs      — advanced console log viewer (same SSE stream as Console Log page)
 */

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  Ban,
  Globe,
  Search,
  Shield,
  ShieldOff,
  Trash2,
  Wifi,
  WifiOff,
} from "lucide-react";
import { toast } from "../../../lib/toast";
import { ApiError, apiDelete, apiGet, apiPost } from "../../../lib/api";
import { formatDuration, formatNumber, formatTime, formatTokens } from "../../../lib/format";
import { qk } from "../../../lib/query-keys";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Select, Tabs } from "../../../components/ui/tabs";
import { ConfirmDialog } from "../../../components/shared";
import { Dialog } from "../../../components/ui/dialog";
import { useConsoleLogStream, type ConsoleLogLevel } from "../../../hooks/use-console-log-stream";

// ── Types ────────────────────────────────────────────────────────────────────

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
  totalTokens: number | null;
  clientName: string;
  clientSource: string;
  tfftMs: number | null;
}

interface IpSummaryRow {
  ip: string;
  requests: number;
  errors: number;
  lastRequestAt: string;
  inputTokens: number;
  outputTokens: number;
}

interface IpBanView {
  ip: string;
  reason: string;
  createdAt: string;
}

const SURFACE_SHORT: Record<string, string> = {
  "openai-chat": "Chat",
  "openai-responses": "Responses",
  "anthropic-messages": "Messages",
  images: "Image",
};

function statusTone(code: number): "ok" | "err" | "warn" | "default" {
  if (code === 0) return "default";
  if (code < 300) return "ok";
  if (code < 400) return "warn";
  return "err";
}

// ── Request Monitor tab ──────────────────────────────────────────────────────

function RequestMonitorTab() {
  const { data, isLoading, refetch } = useQuery({
    queryKey: qk.systemMonitoring.requests,
    queryFn: () => apiGet<{ items: RequestHistoryItem[] }>("/usage/requests?limit=100"),
    refetchInterval: 5_000,
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
      const haystack = `${item.requestId} ${item.endpoint} ${item.providerId ?? ""} ${item.model ?? ""} ${item.clientIp ?? ""} ${item.apiKeyPrefix ?? ""} ${item.errorKind ?? ""}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [items, search, statusFilter]);

  return (
    <>
      <div className="flex w-full flex-wrap items-center gap-2">
        <div className="relative w-full sm:mr-auto sm:w-56">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)]" aria-hidden="true" />
          <Input
            aria-label="Search requests"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by IP, model, provider…"
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

      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-fade">
          {isLoading ? (
            <div className="flex h-full min-h-[220px] items-center justify-center">
              <p className="font-sans text-sm text-[var(--text-3)]">Loading requests…</p>
            </div>
          ) : visible.length === 0 ? (
            <div className="flex h-full min-h-[220px] items-center justify-center">
              <p className="text-center font-sans text-sm text-[var(--text-1)]">No requests{statusFilter !== "all" ? ` with status ${statusFilter}` : ""}{search.trim() ? ` matching "${search.trim()}"` : ""}.</p>
            </div>
          ) : (
            <div className="w-full">
              <div className="sticky top-0 z-10 grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,0.7fr)_minmax(0,0.7fr)_minmax(0,0.6fr)_minmax(0,0.6fr)] gap-2 border-b border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
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
                  className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,0.7fr)_minmax(0,0.7fr)_minmax(0,0.6fr)_minmax(0,0.6fr)] gap-2 border-b border-[var(--inner-border)]/50 px-3 py-2 text-[11px] transition-colors hover:bg-[var(--hover)]"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[var(--text-2)]">{formatTime(item.startedAt)}</div>
                    <div className="truncate text-[9.5px] text-[var(--text-3)]">{SURFACE_SHORT[item.surface] ?? item.surface}{item.mode === "stream" ? " · stream" : ""}</div>
                  </div>
                  <div className="min-w-0">
                    <div className="truncate font-mono text-[10px] text-[var(--text-2)]">{item.clientIp ?? "—"}</div>
                    <div className="truncate text-[9.5px] text-[var(--text-3)]">{item.clientName}</div>
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-[var(--text-2)]">{item.providerId ?? "—"}</div>
                    <div className="truncate font-mono text-[9.5px] text-[var(--text-3)]">{item.model ?? "—"}</div>
                  </div>
                  <div className="flex flex-col items-start gap-0.5">
                    <Badge tone={statusTone(item.statusCode)}>{item.statusCode || "—"}</Badge>
                    {item.errorKind && <span className="max-w-full truncate text-[9px] text-[var(--red)]" title={item.errorKind}>{item.errorKind}</span>}
                  </div>
                  <div className="min-w-0">
                    <div className="tabular-nums text-[var(--text-2)]">{item.totalTokens != null ? formatNumber(item.totalTokens) : "—"}</div>
                    <div className="text-[9px] text-[var(--text-3)]">
                      {item.inputTokens != null && <span>in {formatTokens(item.inputTokens)}</span>}
                      {item.cachedTokens != null && item.cachedTokens > 0 && <span> · cached {formatTokens(item.cachedTokens)}</span>}
                    </div>
                  </div>
                  <div className="min-w-0">
                    <div className="tabular-nums text-[var(--text-2)]">{formatDuration(item.durationMs)}</div>
                    {item.tfftMs != null && <div className="text-[9px] text-[var(--text-3)]">ttft {formatDuration(item.tfftMs)}</div>}
                  </div>
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
            Showing {visible.length} of {items.length} requests
          </span>
          <span className="shrink-0">Auto-refresh 5s</span>
        </footer>
      </Card>
    </>
  );
}

// ── IP Monitor tab ───────────────────────────────────────────────────────────

function IpMonitorTab() {
  const queryClient = useQueryClient();
  const { data: summaryData, isLoading: summaryLoading } = useQuery({
    queryKey: qk.systemMonitoring.ipSummary,
    queryFn: () => apiGet<{ items: IpSummaryRow[] }>("/ips/summary?limit=200"),
    refetchInterval: 5_000,
  });
  const { data: bansData } = useQuery({
    queryKey: qk.systemMonitoring.ipBans,
    queryFn: () => apiGet<{ items: IpBanView[] }>("/ip-bans"),
    refetchInterval: 10_000,
  });

  const [search, setSearch] = useState("");
  const [banDialog, setBanDialog] = useState<{ ip: string } | null>(null);
  const [banReason, setBanReason] = useState("");

  const bannedSet = useMemo(() => new Set((bansData?.items ?? []).map((b) => b.ip)), [bansData]);
  const rows = summaryData?.items ?? [];

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter((row) => row.ip.toLowerCase().includes(query));
  }, [rows, search]);

  const banMutation = useMutation({
    mutationFn: (vars: { ip: string; reason: string }) => apiPost<{ ip: string }>("/ip-bans", vars),
    onSuccess: (_data, vars) => {
      toast.success(`Banned ${vars.ip}`);
      void queryClient.invalidateQueries({ queryKey: qk.systemMonitoring.ipBans });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : "Failed to ban IP";
      toast.error(msg);
    },
  });

  const unbanMutation = useMutation({
    mutationFn: (ip: string) => apiDelete(`/ip-bans/${encodeURIComponent(ip)}`),
    onSuccess: (_data, ip) => {
      toast.success(`Unbanned ${ip}`);
      void queryClient.invalidateQueries({ queryKey: qk.systemMonitoring.ipBans });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : "Failed to unban IP";
      toast.error(msg);
    },
  });

  const banCount = bannedSet.size;

  return (
    <>
      <div className="flex w-full flex-wrap items-center gap-2">
        <div className="relative w-full sm:mr-auto sm:w-56">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)]" aria-hidden="true" />
          <Input
            aria-label="Search IP addresses"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search IP…"
            className="h-8 pl-8 pr-2 text-xs"
          />
        </div>
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--text-2)]">
          <Ban size={13} className="text-[var(--red)]" />
          {banCount} banned
        </div>
      </div>

      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-fade">
          {summaryLoading ? (
            <div className="flex h-full min-h-[220px] items-center justify-center">
              <p className="font-sans text-sm text-[var(--text-3)]">Loading IP summary…</p>
            </div>
          ) : visible.length === 0 ? (
            <div className="flex h-full min-h-[220px] items-center justify-center">
              <p className="text-center font-sans text-sm text-[var(--text-1)]">No IP activity recorded{search.trim() ? ` matching "${search.trim()}"` : ""}.</p>
            </div>
          ) : (
            <div className="w-full">
              <div className="sticky top-0 z-10 grid grid-cols-[minmax(0,1.5fr)_minmax(0,0.8fr)_minmax(0,0.6fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_minmax(0,1.2fr)] gap-2 border-b border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-3)]">
                <span>IP Address</span>
                <span>Requests</span>
                <span>Errors</span>
                <span>Tokens</span>
                <span>Last Seen</span>
                <span>Action</span>
              </div>
              {visible.map((row) => {
                const isBanned = bannedSet.has(row.ip);
                return (
                  <div
                    key={row.ip}
                    className="grid grid-cols-[minmax(0,1.5fr)_minmax(0,0.8fr)_minmax(0,0.6fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_minmax(0,1.2fr)] gap-2 border-b border-[var(--inner-border)]/50 px-3 py-2 text-[11px] transition-colors hover:bg-[var(--hover)]"
                  >
                    <div className="flex min-w-0 items-center gap-1.5">
                      {isBanned ? (
                        <Ban size={12} className="shrink-0 text-[var(--red)]" aria-hidden="true" />
                      ) : (
                        <Globe size={12} className="shrink-0 text-[var(--text-3)]" aria-hidden="true" />
                      )}
                      <span className="truncate font-mono text-[10px] text-[var(--text-2)]">{row.ip}</span>
                      {isBanned && <Badge tone="err">Banned</Badge>}
                    </div>
                    <div className="tabular-nums text-[var(--text-2)]">{formatNumber(row.requests)}</div>
                    <div className="tabular-nums">
                      {row.errors > 0 ? (
                        <span className="text-[var(--red)]">{formatNumber(row.errors)}</span>
                      ) : (
                        <span className="text-[var(--text-3)]">0</span>
                      )}
                    </div>
                    <div className="min-w-0 tabular-nums text-[var(--text-2)]">
                      <span>{formatTokens(row.inputTokens + row.outputTokens)}</span>
                      <div className="text-[9px] text-[var(--text-3)]">
                        in {formatTokens(row.inputTokens)} · out {formatTokens(row.outputTokens)}
                      </div>
                    </div>
                    <div className="min-w-0 text-[var(--text-2)]">{formatTime(row.lastRequestAt)}</div>
                    <div className="flex items-center gap-1">
                      {isBanned ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          className="h-6 px-2 text-[10px]"
                          onClick={() => void unbanMutation.mutate(row.ip)}
                          disabled={unbanMutation.isPending}
                        >
                          <ShieldOff size={11} />
                          Unban
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 border-[var(--red)]/30 px-2 text-[10px] text-[var(--red)] hover:bg-[var(--red-soft)] hover:text-[var(--red)]"
                          onClick={() => {
                            setBanReason("");
                            setBanDialog({ ip: row.ip });
                          }}
                        >
                          <Shield size={11} />
                          Ban
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <footer className="flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-2 border-t border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2 text-[10px] text-[var(--text-3)]">
          <span className="min-w-0 truncate" aria-live="polite">
            {visible.length} IPs · {banCount} banned
          </span>
          <span className="shrink-0">Auto-refresh 5s</span>
        </footer>
      </Card>

      <Dialog
        open={banDialog !== null}
        onClose={() => setBanDialog(null)}
        title={`Ban IP ${banDialog?.ip ?? ""}`}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setBanDialog(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                if (banDialog) {
                  void banMutation.mutate({ ip: banDialog.ip, reason: banReason.trim() });
                  setBanDialog(null);
                }
              }}
              disabled={banMutation.isPending}
            >
              <Ban size={13} />
              Ban IP
            </Button>
          </>
        }
      >
        <p className="text-sm text-[var(--text-2)]">
          This IP will be blocked from making any API requests immediately. You can unban it later from the IP Monitor tab.
        </p>
        <Input
          aria-label="Ban reason (optional)"
          value={banReason}
          onChange={(e) => setBanReason(e.target.value)}
          placeholder="Reason (optional)"
          className="mt-3 h-8 text-xs"
          autoFocus
        />
      </Dialog>
    </>
  );
}

// ── Console Logs tab ─────────────────────────────────────────────────────────

const LEVEL_COLORS: Record<ConsoleLogLevel, string> = {
  debug: "text-[var(--text-3)]",
  info: "text-[#0fa3d1] dark:text-[var(--teal)]",
  warn: "text-[var(--orange)]",
  error: "text-[var(--red)]",
};

const LOG_FILTERS: Array<ConsoleLogLevel | "all"> = ["all", "debug", "info", "warn", "error"];

const ConsoleLogRow = memo(function ConsoleLogRow({
  line,
  isNew,
}: {
  line: { id: number; ts: string; level: ConsoleLogLevel; msg: string };
  isNew: boolean;
}) {
  return (
    <div
      className={`flex gap-2 px-3 py-1 text-[11px] leading-relaxed transition-colors ${isNew ? "bg-[var(--accent-soft)]/30" : ""} hover:bg-[var(--hover)]/50`}
    >
      <span className="shrink-0 tabular-nums text-[var(--text-3)]">{formatTime(line.ts)}</span>
      <span className={`shrink-0 font-semibold uppercase ${LEVEL_COLORS[line.level]}`} style={{ minWidth: "3rem" }}>
        {line.level}
      </span>
      <span className="min-w-0 break-all text-[var(--text-2)]">{line.msg}</span>
    </div>
  );
});

function ConsoleLogsTab() {
  const { lines, newLineIds, status, attempts } = useConsoleLogStream();
  const [filter, setFilter] = useState<ConsoleLogLevel | "all">("all");
  const [search, setSearch] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [clearOpen, setClearOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return lines.filter((line) => {
      if (filter !== "all" && line.level !== filter) return false;
      if (!query) return true;
      return `${line.ts} ${line.level} ${line.scope} ${line.msg}`.toLowerCase().includes(query);
    });
  }, [filter, lines, search]);

  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
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
        <div className="relative w-full sm:mr-auto sm:w-56">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)]" aria-hidden="true" />
          <Input
            aria-label="Search console logs"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search logs..."
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
          ariaLabel="Filter log level"
          value={filter}
          onChange={(value) => setFilter(value as ConsoleLogLevel | "all")}
          options={LOG_FILTERS.map((level) => ({ value: level, label: level === "all" ? "All" : level.charAt(0).toUpperCase() + level.slice(1) }))}
        />
        <Button variant="secondary" size="sm" onClick={() => setAutoScroll(true)} disabled={autoScroll}>
          <ArrowDown size={13} /> {autoScroll ? "Following" : "Follow"}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setClearOpen(true)}>
          <Trash2 size={13} /> Clear
        </Button>
      </div>

      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
        <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 font-mono text-[11.5px] leading-relaxed">
          {visible.length === 0 ? (
            <div className="flex h-full min-h-[220px] items-center justify-center">
              <p className="text-center font-sans text-sm text-[var(--text-1)]">No log lines{filter !== "all" ? ` at ${filter} level` : ""}.</p>
            </div>
          ) : (
            visible.map((line) => <ConsoleLogRow key={line.id} line={line} isNew={newLineIds.has(line.id)} />)
          )}
        </div>
        <footer className="flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-2 border-t border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2 text-[10px] text-[var(--text-3)]">
          <span className="min-w-0 truncate" aria-live="polite">
            {visible.length} of {lines.length} lines{filter !== "all" ? ` · ${filter}` : ""}{search.trim() ? ` · search: "${search.trim()}"` : ""}
          </span>
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

// ── Main page ────────────────────────────────────────────────────────────────

export function SystemMonitoringPage() {
  const [tab, setTab] = useState("requests");

  return (
    <div className="dashboard-page flex min-h-0 flex-1 flex-col gap-3 overflow-hidden pt-2 sm:pt-0">
      <Tabs
        tabs={[
          { id: "requests", label: "Request Monitor" },
          { id: "ips", label: "IP Monitor" },
          { id: "logs", label: "Console Logs" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "requests" ? <RequestMonitorTab /> : tab === "ips" ? <IpMonitorTab /> : <ConsoleLogsTab />}
    </div>
  );
}
