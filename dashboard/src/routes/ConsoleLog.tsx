/**
 * Console Log + Audit Trail viewer.
 *
 * Two tabs share one page shell:
 *   - Console Log — live server-log tail over SSE (snapshot + appended
 *     lines + clear), filterable by level, newest at the bottom with
 *     stick-to-bottom auto-scroll. This is process stdout surfaced to the
 *     dashboard; request telemetry already lives on the Usage page.
 *   - Audit — every privileged mutation the console recorded to
 *     `admin_audit_log`, cursor-paginated, filterable by action + actor
 *     (actor accepts a username or a raw id). Requires platform:admin; the
 *     backend returns 403 for lesser scopes.
 */
import { RefreshCw, ScrollText, Search, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Badge } from "../components/ui/badge";
import { formatDuration } from "../lib/format";
import { Button } from "../components/ui/button";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DataTable } from "../components/ui/layout";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/state";
import { Input } from "../components/ui/input";
import type { AuditEntry } from "../lib/contracts";
import { useAuditTrail, useSessionUser } from "../lib/hooks/system";
import { useConsoleLogStream, type ConsoleLogEntry, type ConsoleLogLevel } from "../lib/hooks/logs";
import { auditActionLabel } from "../lib/audit-labels";
import { getErrorMessage } from "../lib/helpers";
import { toast } from "../lib/toast";

type TabKey = "logs" | "audit";
const PAGE_SIZE = 50;

const LEVEL_FILTERS: ReadonlyArray<{ id: "all" | ConsoleLogLevel; label: string }> = [
  { id: "all", label: "All" },
  { id: "debug", label: "Debug" },
  { id: "info", label: "Info" },
  { id: "warn", label: "Warn" },
  { id: "error", label: "Error" },
];

const LEVEL_COLOR: Record<ConsoleLogLevel, string> = {
  debug: "var(--text-tertiary)",
  info: "var(--accent)",
  warn: "var(--orange)",
  error: "var(--red)",
};

/** Short level tag, so severity is readable without decoding a colour. */
const LEVEL_LABEL: Record<ConsoleLogLevel, string> = {
  debug: "DBG",
  info: "INF",
  warn: "WRN",
  error: "ERR",
};

/** Status tone for the badge: 2xx ok, 4xx warn, 5xx error. */
export function statusTone(status: number): "ok" | "warn" | "err" {
  if (status >= 500) return "err";
  if (status >= 400) return "warn";
  return "ok";
}

/** Compact duration: sub-second stays in ms, longer reads as seconds. */
/**
 * Applies the level and search filters to the live tail.
 *
 * Extracted from the panel so the predicate is directly testable: the level
 * check was previously computed but never consulted, which made the level
 * buttons inert.
 */
export function filterLogLines(
  lines: readonly ConsoleLogEntry[],
  level: "all" | ConsoleLogLevel,
  query: string,
): ConsoleLogEntry[] {
  const normalized = query.trim().toLowerCase();
  return lines.filter((line) => {
    if (level !== "all" && line.level !== level) return false;
    if (!normalized) return true;
    const haystack = `${line.msg} ${line.endpoint ?? ""} ${line.model ?? ""} ${line.routedModel ?? ""} ${line.providerId ?? ""} ${line.errorCode ?? ""} ${line.userAgent ?? ""} ${line.clientIp ?? ""} ${line.accountLabel ?? ""}`.toLowerCase();
    return haystack.includes(normalized);
  });
}


export default function ConsoleLog(): ReactNode {
  const [tab, setTab] = useState<TabKey>("logs");
  const sessionQuery = useSessionUser();
  const isPlatformAdmin = sessionQuery.data?.isPlatformAdmin ?? false;
  const activeTab = tab === "audit" && !isPlatformAdmin ? "logs" : tab;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        height: "calc(100vh - 160px)",
        minHeight: "480px",
      }}
    >
      <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
        <Button
          variant={activeTab === "logs" ? "primary" : "secondary"}
          size="sm"
          onClick={() => setTab("logs")}
          icon={<ScrollText size={13} />}
          aria-pressed={activeTab === "logs"}
        >
          Console Log
        </Button>
        {isPlatformAdmin ? (
          <Button
            variant={activeTab === "audit" ? "primary" : "secondary"}
            size="sm"
            onClick={() => setTab("audit")}
            icon={<ShieldCheck size={13} />}
            aria-pressed={activeTab === "audit"}
          >
            Admin Audit
          </Button>
        ) : null}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {activeTab === "logs" ? <LiveLogsPanel /> : <AuditPanel />}
      </div>
    </div>
  );
}

function formatClock(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return date.toLocaleTimeString([], { hour12: false });
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function readTokenUsage(line: ConsoleLogEntry): string | null {
  const details = line.details;
  if (!details) return null;
  const input = typeof details.inputTokens === "number" ? details.inputTokens : undefined;
  const output = typeof details.outputTokens === "number" ? details.outputTokens : undefined;
  const cached = typeof details.cachedInputTokens === "number" ? details.cachedInputTokens : undefined;
  const reasoning = typeof details.reasoningTokens === "number" ? details.reasoningTokens : undefined;
  if (input === undefined && output === undefined && cached === undefined && reasoning === undefined) {
    return null;
  }
  const parts: string[] = [];
  if (input !== undefined) parts.push(`${formatCount(input)} in`);
  if (output !== undefined) parts.push(`${formatCount(output)} out`);
  if (cached !== undefined) parts.push(`${formatCount(cached)} cached`);
  if (reasoning !== undefined && reasoning > 0) parts.push(`${formatCount(reasoning)} reason`);
  return parts.join(" / ");
}

/**
 * How the model resolved: `provider/routed ← requested` when an alias or combo
 * rewrote it, plain `provider/model` when it went through untouched, and the
 * requested model alone for a request that failed before routing.
 */
function eventRoute(line: ConsoleLogEntry): string | null {
  const requested = line.model;
  const routed = line.routedModel;
  const provider = line.providerId;
  const resolved = routed ?? requested;
  if (!resolved && !provider) return null;
  const target = provider && resolved ? `${provider}/${resolved}` : resolved ?? provider ?? "";
  if (routed && requested && routed !== requested) {
    return `${target} ← ${requested}`;
  }
  return target;
}
/**
 * One log row. Structured request lines render as aligned fields (method, path,
 * status, route, model, client, duration) so a scan down the column reads as a
 * table; plain server lines keep the original message text.
 */
function LogRow({
  line,
  isNew,
}: {
  readonly line: ConsoleLogEntry;
  readonly isNew: boolean;
}): ReactNode {
  const isRequest = line.event !== undefined;
  const tone = line.level;
  return (
    <div className={`console-log-row console-log-row--${tone}${isNew ? " is-new" : ""}`}>
      <span className="console-log-time">{formatClock(line.ts)}</span>
      <span
        className="console-log-level"
        style={{ color: LEVEL_COLOR[line.level] }}
        title={line.level.toUpperCase()}
      >
        {LEVEL_LABEL[line.level]}
      </span>
      {isRequest ? <RequestFields line={line} /> : <span className="console-log-msg">{line.msg}</span>}
    </div>
  );
}

/** The structured half of a request lifecycle row. */
function RequestFields({ line }: { readonly line: ConsoleLogEntry }): ReactNode {
  const isStart = line.event === "request_start";
  const route = eventRoute(line);
  const tokens = readTokenUsage(line);
  return (
    <>
      <span className="console-log-method">{line.method ?? "POST"}</span>
      <span className="console-log-path">{line.endpoint ?? ""}</span>
      {line.status !== undefined ? (
        <span className={`console-log-status console-log-status--${statusTone(line.status)}`}>
          {line.status}
        </span>
      ) : (
        <span className="console-log-status console-log-status--pending">···</span>
      )}
      {route ? <span className="console-log-route">{route}</span> : null}
      {line.accountLabel ? (
        <span className="console-log-account" title={line.accountId ?? undefined}>
          {line.accountLabel}
        </span>
      ) : null}
      {line.clientIp ? <span className="console-log-ip">{line.clientIp}</span> : null}
      {line.durationMs !== undefined ? (
        <span className="console-log-duration">{formatDuration(line.durationMs)}</span>
      ) : null}
      {tokens ? <span className="console-log-tokens">{tokens}</span> : null}
      {line.errorCode ? (
        <span className="console-log-error" title={line.msg}>
          {line.errorCode}
        </span>
      ) : null}
      {isStart ? null : <span className="console-log-id">{line.requestId?.slice(0, 8) ?? ""}</span>}
    </>
  );
}


function LiveLogsPanel(): ReactNode {
  const { lines, newLineIds, clear } = useConsoleLogStream();
  const [level, setLevel] = useState<"all" | ConsoleLogLevel>("all");
  const [search, setSearch] = useState("");
  const [clearOpen, setClearOpen] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const normalizedQuery = search.trim().toLowerCase();
  const visible = useMemo(
    () => filterLogLines(lines, level, normalizedQuery),
    [lines, level, normalizedQuery],
  );
  useEffect(() => {
    if (!stickRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length, level, normalizedQuery]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  const onClear = async () => {
    setClearError(null);
    try {
      await clear();
      setClearOpen(false);
      toast.success("Console logs cleared");
    } catch {
      setClearError("Failed to clear server logs.");
    }
  };

  return (
    <Card style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <CardHeader
        title="Console Log"
        subtitle={`${visible.length} of ${lines.length} lines`}
        icon={<ScrollText size={16} />}
      />
      <CardBody className="console-log-toolbar">
        <div className="console-log-filters" role="group" aria-label="Log level">
          {LEVEL_FILTERS.map((option) => {
            const count = option.id === "all" ? lines.length : lines.filter((line) => line.level === option.id).length;
            return (
              <button
                className={`console-log-filter${level === option.id ? " is-active" : ""}`}
                key={option.id}
                type="button"
                onClick={() => setLevel(option.id)}
                aria-pressed={level === option.id}
              >
                <span>{option.label}</span>
                <span className="console-log-filter-count">{count}</span>
              </button>
            );
          })}
        </div>
        <div className="console-log-tools">
          <div className="console-log-search">
            <Search size={13} aria-hidden="true" />
            <Input
              aria-label="Search console logs"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search logs..."
            />
          </div>
          <button className="console-log-clear-icon" type="button" onClick={() => setClearOpen(true)} aria-label="Clear console logs" title="Clear logs">
            <Trash2 size={15} aria-hidden="true" />
          </button>
        </div>
      </CardBody>
      <CardBody style={{ padding: 0, flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <div ref={scrollRef} onScroll={onScroll} className="console-log-scroll">
          {visible.length === 0 ? (
            <EmptyState
              title={
                lines.length === 0
                  ? "No log lines yet"
                  : normalizedQuery
                    ? "No lines match your search"
                    : "No lines match this level"
              }
              message={
                lines.length === 0
                  ? "Server log output will stream here as the gateway runs."
                  : "Adjust the search or pick another level to widen the view."
              }
              icon={<ScrollText size={20} />}
            />
          ) : (
            visible.map((line) => (
              <LogRow key={line.id} line={line} isNew={newLineIds.has(line.id)} />
            ))
          )}
        </div>
        <div className="console-log-footer" aria-live="polite">
          <span className="console-log-footer-text">
            {visible.length} of {lines.length} lines
            {level !== "all" ? ` · ${level}` : ""}
            {normalizedQuery ? ` · search: "${search.trim()}"` : ""}
          </span>
        </div>
      </CardBody>

      <ConfirmDialog
        open={clearOpen}
        onClose={() => setClearOpen(false)}
        onConfirm={onClear}
        title="Clear console logs"
        message="Clear the in-memory server log tail? New lines keep streaming afterwards."
        confirmLabel="Clear"
        danger
      />
      {clearError ? (
        <span style={{ fontSize: "11px", color: "var(--red)", padding: "0 16px 8px" }}>{clearError}</span>
      ) : null}
    </Card>
  );
}


function AuditPanel(): ReactNode {
  const [actionFilter, setActionFilter] = useState("");
  const [actorFilter, setActorFilter] = useState("");
  const [debouncedAction, setDebouncedAction] = useState("");
  const [debouncedActor, setDebouncedActor] = useState("");
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedAction(actionFilter), 300);
    return () => clearTimeout(timer);
  }, [actionFilter]);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedActor(actorFilter), 300);
    return () => clearTimeout(timer);
  }, [actorFilter]);
  const query = useAuditTrail({
    limit: PAGE_SIZE,
    ...(debouncedAction ? { action: debouncedAction } : {}),
    ...(debouncedActor ? { actor: debouncedActor } : {}),
    ...(cursor ? { cursor } : {}),
  });
  const page = query.data;
  const entries = page?.entries ?? [];
  const nextCursor = page?.nextCursor;
  const advance = () => {
    if (!nextCursor) return;
    setCursorStack((stack) => [...stack, cursor ?? ""]);
    setCursor(nextCursor);
  };
  const back = () => {
    setCursorStack((stack) => {
      const previous = stack[stack.length - 1];
      setCursor(previous ? previous : undefined);
      return stack.slice(0, -1);
    });
  };
  const resetFilters = () => {
    setCursor(undefined);
    setCursorStack([]);
  };
  return (
    <Card style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <CardHeader
        title="Admin Audit Trail"
        subtitle="Every privileged console mutation, retained on its own lifecycle"
        icon={<ShieldCheck size={16} />}
        action={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
            icon={<RefreshCw size={13} className={query.isFetching ? "animate-spin" : ""} />}
          >
            Refresh
          </Button>
        }
      />
      <CardBody
        style={{
          padding: "10px 16px",
          display: "flex",
          gap: "12px",
          alignItems: "flex-end",
          flexShrink: 0,
          borderBottom: "1px solid var(--inner-border)",
        }}
      >
        <Input
          label="Action"
          placeholder="e.g. provider updated"
          value={actionFilter}
          onChange={(e) => {
            setActionFilter(e.target.value);
            resetFilters();
          }}
        />
        <Input
          label="Actor"
          placeholder="e.g. alice or a user id"
          value={actorFilter}
          onChange={(e) => {
            setActorFilter(e.target.value);
            resetFilters();
          }}
        />
        <div style={{ marginLeft: "auto", display: "flex", gap: "8px" }}>
          <Button size="sm" variant="secondary" onClick={back} disabled={cursorStack.length === 0}>
            ← Newer
          </Button>
          <Button size="sm" variant="secondary" onClick={advance} disabled={!nextCursor}>
            Older →
          </Button>
        </div>
      </CardBody>
      <CardBody
        style={{
          padding: 0,
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          overflowY: "auto",
        }}
      >
        {query.isPending && entries.length === 0 ? (
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "32px",
            }}
          >
            <LoadingState label="Loading audit trail…" />
          </div>
        ) : query.isError && entries.length === 0 ? (
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "32px",
            }}
          >
            <ErrorState
              message={getErrorMessage(query.error, "Unable to load audit trail.")}
              onRetry={() => void query.refetch()}
            />
          </div>
        ) : entries.length === 0 ? (
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "32px",
            }}
          >
            <EmptyState
              title="No audit entries yet"
              message="Privileged mutations (provider changes, key rotations, backups, bans) will appear here."
              icon={<ShieldCheck size={20} />}
            />
          </div>
        ) : (
          <div style={{ flex: 1, overflowY: "auto" }}>
            <DataTable headers={["Timestamp", "Actor", "Action", "Target", "Detail"]}>
              {entries.map((entry) => (
                <AuditRow key={entry.id} entry={entry} />
              ))}
            </DataTable>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function AuditRow({ entry }: { entry: AuditEntry }): ReactNode {
  return (
    <tr>
      <td style={{ fontSize: "11.5px", color: "var(--text-tertiary)", whiteSpace: "nowrap" }}>
        {new Date(entry.createdAt).toLocaleString()}
      </td>
      <td style={{ maxWidth: "200px" }}>
        <div style={{ fontSize: "12.5px", fontWeight: 600 }}>{entry.actorName ?? entry.actor}</div>
        {entry.actorName ? (
          <div
            className="truncate"
            title={entry.actor}
            style={{ fontFamily: "var(--font-mono)", fontSize: "10.5px", color: "var(--text-tertiary)" }}
          >
            {entry.actor}
          </div>
        ) : null}
      </td>
      <td>
        <Badge
          tone={entry.action.includes("delete") || entry.action.includes("revoked") ? "err" : "ok"}
          title={entry.action}
        >
          {auditActionLabel(entry.action)}
        </Badge>
      </td>
      <td
        className="truncate"
        title={entry.target}
        style={{ fontFamily: "var(--font-mono)", fontSize: "11.5px", maxWidth: "220px" }}
      >
        {entry.target}
      </td>
      <td
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "11px",
          maxWidth: "320px",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {entry.detail ? JSON.stringify(entry.detail) : "—"}
      </td>
    </tr>
  );
}
