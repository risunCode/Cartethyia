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
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Badge } from "../../components/ui/badge";
import { formatDuration } from "../../lib/format/numbers";
import { Button } from "../../components/ui/button";
import { Card, CardBody, CardHeader } from "../../components/ui/card";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { DataTable } from "../../components/ui/layout";
import { EmptyState, ErrorState, LoadingState } from "../../components/ui/state";
import { Input } from "../../components/ui/input";
import type { AuditEntry } from "../../data/contracts";
import { useAuditTrail, useSessionUser } from "../../hooks/system";
import { useConsoleLogStream, type ConsoleLogEntry, type ConsoleLogLevel } from "../../hooks/logs";
import { auditActionLabel } from "../../features/logs/audit-labels";
import { getErrorMessage } from "../../data/api";
import { toast } from "../../lib/toast";

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


export default function ConsoleLogPage(): ReactNode {
  const [tab, setTab] = useState<TabKey>("logs");
  const sessionQuery = useSessionUser();
  const isPlatformAdmin = sessionQuery.data?.isPlatformAdmin ?? false;
  const activeTab = tab === "audit" && !isPlatformAdmin ? "logs" : tab;
  const tabAction = (
    <div className="flex gap-4">
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
  );
  return (
    <div className="flex flex-col flex-1 min-h-0">
      {activeTab === "logs" ? (
        <LiveLogsPanel tabAction={tabAction} />
      ) : (
        <AuditPanel tabAction={tabAction} />
      )}
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
/**
 * One log line.
 *
 * Memoized: the stream appends a line at a time, and without this every append
 * re-rendered the whole retained window (up to 500 rows) for one new line.
 */
const LogRow = memo(function LogRow({
  line,
  isNew,
}: {
  readonly line: ConsoleLogEntry;
  readonly isNew: boolean;
}): ReactNode {
  const isRequest = line.event !== undefined;
  const tone = line.level;
  return (
    <div
      className={`flex flex-wrap items-baseline gap-4 px-8 py-1.5 min-h-10.5 font-mono text-caption leading-normal max-medium:gap-3 max-medium:px-5 max-medium:text-badge${tone === "warn" ? " bg-orange-soft" : tone === "error" ? " bg-red-soft" : ""}${isNew ? " bg-surface-muted" : ""} hover:bg-surface-hover`}
      data-log-tone={tone}
    >
      <span className="max-medium:flex-none flex-none tabular-nums text-text-tertiary">{formatClock(line.ts)}</span>
      <span
        className="flex-none w-13 text-left text-micro font-bold tracking-label"
        style={{ color: LEVEL_COLOR[line.level] }}
        title={line.level.toUpperCase()}
      >
        {LEVEL_LABEL[line.level]}
      </span>
      {isRequest ? <RequestFields line={line} /> : <span className="min-w-0 flex-1 whitespace-pre-wrap wrap-anywhere break-words text-text-secondary">{line.msg}</span>}
    </div>
  );
});

/**
 * The structured half of a request lifecycle row. The whole row is a single
 * flex line; request fields are inline chips inside one wrapping span so a
 * wrapped message does not push a `>` or `{` onto the next timestamp.
 */
function RequestFields({ line }: { readonly line: ConsoleLogEntry }): ReactNode {
  const isStart = line.event === "request_start";
  const route = eventRoute(line);
  const tokens = readTokenUsage(line);
  return (
    <span className="contents whitespace-pre-wrap wrap-anywhere">
      <span className="max-medium:hidden flex-none min-w-19 text-text-tertiary text-badge font-semibold">{line.method ?? "POST"}</span>
      <span className="flex-none text-text-primary">{line.endpoint ?? ""}</span>
      {line.status !== undefined ? (
        <span className={`flex-none min-w-15 tabular-nums${statusTone(line.status) === "ok" ? " text-text-tertiary" : statusTone(line.status) === "warn" ? " text-orange font-semibold" : " text-red font-semibold"}`}>
          {line.status}
        </span>
      ) : (
        <span className="flex-none min-w-15 tabular-nums tracking-label text-text-tertiary">···</span>
      )}
      {route ? <span className="flex-auto min-w-0 overflow-hidden text-ellipsis text-status-info" data-log-field="route">{route}</span> : null}
      {line.accountLabel ? (
        <span className="max-medium:hidden flex-none max-w-80 overflow-hidden text-ellipsis text-purple" data-log-field="account" title={line.accountId ?? undefined}>
          {line.accountLabel}
        </span>
      ) : null}
      {line.clientIp ? <span className="flex-none tabular-nums text-text-secondary" data-log-field="ip">{line.clientIp}</span> : null}
      {line.durationMs !== undefined ? (
        <span className="max-medium:hidden flex-none tabular-nums text-text-secondary">{formatDuration(line.durationMs)}</span>
      ) : null}
      {tokens ? <span className="max-medium:hidden flex-none tabular-nums text-orange" data-log-field="tokens">{tokens}</span> : null}
      {line.errorCode ? (
        <>
          <span className="text-red" title={line.msg}>
            {line.msg}
          </span>
          <span title={line.msg}>
            {line.errorCode}
          </span>
        </>
      ) : null}
      {isStart ? null : <span className="flex-none ml-auto text-micro text-text-tertiary" data-log-field="id">{line.requestId?.slice(0, 8) ?? ""}</span>}
    </span>
  );
}


function LiveLogsPanel({ tabAction }: { tabAction: ReactNode }): ReactNode {
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
  // Counts per level: one pass instead of one `filter` per filter button on
  // every append.
  const levelCounts = useMemo(() => {
    const counts = new Map<string, number>([["all", lines.length]]);
    for (const line of lines) counts.set(line.level, (counts.get(line.level) ?? 0) + 1);
    return counts;
  }, [lines]);
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
    <Card className="flex-1 min-h-0 flex flex-col">
      <CardHeader
        title="Console Log"
        subtitle={`${visible.length} of ${lines.length} lines`}
        icon={<ScrollText size={16} />}
        action={tabAction}
      />
      <CardBody className="flex flex-row items-center justify-between gap-8 flex-none min-h-0 px-7 py-4 border-b border-inner-border max-medium:flex-col max-medium:items-start max-medium:gap-4">
        <div className="inline-flex items-center gap-1.5 flex-none max-medium:w-full max-medium:overflow-x-auto" role="group" aria-label="Log level">
          {LEVEL_FILTERS.map((option) => {
            const count = levelCounts.get(option.id) ?? 0;
            return (
              <button
                className={`inline-flex items-center appearance-none border-0 rounded-tiny px-5 py-3.5 bg-transparent font-sans text-badge font-semibold leading-none cursor-pointer ${level === option.id ? "bg-surface-muted text-text-primary" : "text-text-tertiary hover:bg-surface-muted hover:text-text-primary"}`}
                key={option.id}
                type="button"
                onClick={() => setLevel(option.id)}
                aria-pressed={level === option.id}
              >
                <span>{option.label}</span>
                <span className="ml-2.5 text-inherit opacity-65 tabular-nums">{count}</span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-4 ml-auto max-medium:w-full max-medium:ml-0 max-medium:min-w-0">
          <div className="relative w-140 min-w-0 max-w-full max-medium:flex-auto max-medium:w-auto">
            <Search size={13} aria-hidden="true" className="absolute left-5 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
            <Input
              aria-label="Search console logs"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search logs..."
              className="pl-15 w-full min-w-0"
            />
          </div>
          <button className="inline-grid place-items-center w-16 h-16 border border-border-subtle rounded-control bg-transparent text-text-secondary cursor-pointer hover:border-red hover:text-red hover:bg-red-soft" type="button" onClick={() => setClearOpen(true)} aria-label="Clear console logs" title="Clear logs">
            <Trash2 size={15} aria-hidden="true" />
          </button>
        </div>
      </CardBody>
      <CardBody className="p-0 flex-1 min-h-0 flex flex-col">
        <div ref={scrollRef} onScroll={onScroll} className="flex-1 min-h-0 flex flex-col overflow-y-auto p-0 bg-code-surface text-text-primary">
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
        <div className="flex items-center justify-between gap-5 shrink-0 px-8 py-4 border-t border-inner-border bg-surface-2 text-micro text-text-tertiary" aria-live="polite">
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
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
        <span className="text-badge text-red pt-0 px-8 pb-4">{clearError}</span>
      ) : null}
    </Card>
  );
}


function AuditPanel({ tabAction }: { tabAction: ReactNode }): ReactNode {
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
    <Card className="flex-1 min-h-0 flex flex-col">
      <CardHeader
        title="Admin Audit Trail"
        subtitle="Every privileged console mutation, retained on its own lifecycle"
        icon={<ShieldCheck size={16} />}
        action={
          <div className="flex gap-4 items-center">
            {tabAction}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
              icon={<RefreshCw size={13} className={query.isFetching ? "animate-spin" : ""} />}
            >
              Refresh
            </Button>
          </div>
        }
      />
      <CardBody className="flex flex-row items-center justify-between gap-6 flex-none min-h-0 px-8 py-5 border-b border-inner-border items-end">
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
        <div className="ml-auto flex gap-4">
          <Button size="sm" variant="secondary" onClick={back} disabled={cursorStack.length === 0}>
            ← Newer
          </Button>
          <Button size="sm" variant="secondary" onClick={advance} disabled={!nextCursor}>
            Older →
          </Button>
        </div>
      </CardBody>
      <CardBody className="p-0 flex-1 min-h-0 flex flex-col">
        <div className="flex-1 min-h-0 flex flex-col overflow-y-auto p-0 bg-transparent text-inherit">
          {query.isPending && entries.length === 0 ? (
            <LoadingState label="Loading audit trail…" />
          ) : query.isError && entries.length === 0 ? (
            <ErrorState
              message={getErrorMessage(query.error, "Unable to load audit trail.")}
              onRetry={() => void query.refetch()}
            />
          ) : entries.length === 0 ? (
            <EmptyState
              title="No audit entries yet"
              message="Privileged mutations (provider changes, key rotations, backups, bans) will appear here."
              icon={<ShieldCheck size={20} />}
            />
          ) : (
            <DataTable headers={["Timestamp", "Actor", "Action", "Target", "Detail"]}>
              {entries.map((entry) => (
                <AuditRow key={entry.id} entry={entry} />
              ))}
            </DataTable>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function AuditRow({ entry }: { entry: AuditEntry }): ReactNode {
  return (
    <tr>
      <td className="text-badge text-text-tertiary whitespace-nowrap">
        {new Date(entry.createdAt).toLocaleString()}
      </td>
      <td className="max-w-100">
        <div className="text-caption font-semibold">{entry.actorName ?? entry.actor}</div>
        {entry.actorName ? (
          <div title={entry.actor}
           className="truncate font-mono tabular-nums text-micro text-text-tertiary">
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
      <td title={entry.target} className="truncate font-mono tabular-nums text-badge max-w-110">
        {entry.target}
      </td>
      <td
        className="font-mono tabular-nums text-badge max-w-160 overflow-hidden truncate"
      >
        {entry.detail ? JSON.stringify(entry.detail) : "—"}
      </td>
    </tr>
  );
}
