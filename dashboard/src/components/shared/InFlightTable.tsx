
import { For, Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { Activity } from "lucide-solid";
import { Card, CardHeader } from "../ui/card";
import { Badge } from "../ui/badge";
import { Skeleton } from "../ui/badge";
import { Button } from "../ui/button";
import { cn } from "../../lib/cn";
import { formatNumber, formatRelativeTime } from "../../lib/format";
import { useSSE } from "@lib/sse";

export interface InFlightRow {
  id: string;
  model: string;
  provider: string;
  ip: string;
  startedAt: string;
  ageMs: number;
  bytes: number | null;
}

export interface InFlightTableProps {
  rows: readonly InFlightRow[];
  loading?: boolean;
  /** Tailwind max-height for the scroll region. */
  maxHeight?: string;
  /** Page size for auto-pagination (default 25). */
  pageSize?: number;
  /** Fired when the user scrolls near the bottom. */
  onLoadMore?: () => void;
  /** Whether more pages are available upstream. */
  hasMore?: boolean;
  emptyMessage?: string;
  className?: string;
  /** Status indicator (e.g. SSE connection state). */
  status?: "connected" | "connecting" | "error" | "idle";
}

const STATUS_TONE: Record<NonNullable<InFlightTableProps["status"]>, "ok" | "info" | "warn" | "neutral"> = {
  connected: "ok",
  connecting: "info",
  error: "warn",
  idle: "neutral",
};

const STATUS_LABEL: Record<NonNullable<InFlightTableProps["status"]>, string> = {
  connected: "Live",
  connecting: "Connecting",
  error: "Reconnecting",
  idle: "Idle",
};

/**
 * InFlightTable — live in-flight request monitor. Auto-paginates in
 * `pageSize` increments when scroll approaches the end. Designed to be
 * driven by an SSE stream emitting updates to `rows`.
 */
export function InFlightTable(props: InFlightTableProps): JSX.Element {
  let scrollElement: HTMLDivElement | null = null;
  const rowHeight = 36;
  const overscan = 6;

  const visibleCount = createMemo(() => Math.min(props.rows.length, props.pageSize ?? 25));
  const visibleItems = createMemo(() => props.rows.slice(0, visibleCount()));

  const virtualizer = createVirtualizer({
    count: visibleItems().length,
    getScrollElement: () => scrollElement,
    estimateSize: () => rowHeight,
    overscan,
  });

  const handleScroll = (event: Event) => {
    const target = event.currentTarget as HTMLDivElement;
    if (!target) return;
    if (visibleCount() >= props.rows.length && !props.hasMore) return;
    const scrollBottom = target.scrollTop + target.clientHeight;
    if (scrollBottom >= target.scrollHeight - target.clientHeight * 2) {
      props.onLoadMore?.();
    }
  };

  onCleanup(() => {
    scrollElement = null;
  });

  return (
    <Card density="compact" className={cn("animate-fade-in flex min-w-0 flex-col", props.className)}>
      <CardHeader title="In-flight requests" icon={Activity} iconColor="#0a84ff" sub={`${props.rows.length} active`}>
        <div class="flex items-center gap-2">
          <Badge tone={STATUS_TONE[props.status ?? "idle"]} className="gap-1.5 font-mono">
            <span
              class={cn(
                "h-2 w-2 rounded-full",
                props.status === "connected" ? "bg-[var(--status-success)] animate-pulse" : "bg-current",
              )}
              aria-hidden="true"
            />
            {STATUS_LABEL[props.status ?? "idle"]}
          </Badge>
          <Show when={props.onLoadMore && (props.hasMore || visibleCount() < props.rows.length)}>
            <Button size="sm" variant="ghost" onClick={() => props.onLoadMore?.()}>
              Load more
            </Button>
          </Show>
        </div>
      </CardHeader>
      <Show
        when={!props.loading || visibleItems().length > 0}
        fallback={
          <div class="space-y-2" aria-label="Loading in-flight rows">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        }
      >
        <Show
          when={visibleItems().length > 0}
          fallback={
            <p class="rounded-lg border border-dashed border-[var(--inner-border)] px-3 py-6 text-center text-xs text-[var(--text-3)]">
              {props.emptyMessage ?? "No in-flight requests."}
            </p>
          }
        >
          <div
            ref={(element) => { scrollElement = element; }}
            class="relative max-w-full overflow-auto"
            style={{ "max-height": props.maxHeight ?? "420px" }}
            onScroll={handleScroll}
            role="region"
            aria-label="In-flight requests"
            tabIndex={0}
          >
            <table class="w-full border-collapse text-left text-xs" style={{ "min-width": "640px" }}>
              <thead>
                <tr class="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">
                  <th scope="col" class="px-2 py-2">Model</th>
                  <th scope="col" class="px-2 py-2">Provider</th>
                  <th scope="col" class="px-2 py-2">Client IP</th>
                  <th scope="col" class="px-2 py-2 text-right">Age</th>
                  <th scope="col" class="px-2 py-2 text-right">Bytes</th>
                </tr>
              </thead>
              <tbody>
                <For each={virtualizer.getVirtualItems()}>
                  {(virtualRow) => {
                    const row = visibleItems()[virtualRow.index];
                    if (!row) return null;
                    return (
                      <tr
                        class="border-t border-[var(--inner-border)] transition-colors duration-150 hover:bg-[var(--hover)]"
                        style={{ height: `${rowHeight}px` }}
                      >
                        <td class="px-2 align-middle font-mono text-[11px] text-[var(--text-1)]">{row.model}</td>
                        <td class="px-2 align-middle text-[11px] text-[var(--text-2)]">{row.provider}</td>
                        <td class="px-2 align-middle font-mono text-[11px] text-[var(--text-2)]">{row.ip}</td>
                        <td class="px-2 align-middle text-right text-[11px] tabular-nums text-[var(--text-2)]">
                          {row.startedAt ? formatRelativeTime(row.startedAt) : "—"}
                        </td>
                        <td class="px-2 align-middle text-right text-[11px] tabular-nums text-[var(--text-2)]">
                          {row.bytes === null ? "—" : row.bytes.toLocaleString("en-US")}
                        </td>
                      </tr>
                    );
                  }}
                </For>
              </tbody>
            </table>
          </div>
          <Show when={props.hasMore || visibleCount() < props.rows.length}>
            <div class="mt-2 flex items-center justify-between px-2 text-[10px] text-[var(--text-3)]">
              <span class="tabular-nums">
                Showing {visibleCount()} of {props.rows.length}
              </span>
              <span>Scroll to load more</span>
            </div>
          </Show>
        </Show>
      </Show>
    </Card>
  );
}

function parseRows(payload: unknown): readonly InFlightRow[] {
  if (Array.isArray(payload)) {
    return payload.filter(isInFlightRow);
  }
  if (typeof payload === "object" && payload !== null && "rows" in payload) {
    const list = (payload as { rows: unknown }).rows;
    if (Array.isArray(list)) return list.filter(isInFlightRow);
  }
  return [];
}

function isInFlightRow(value: unknown): value is InFlightRow {
  if (typeof value !== "object" || value === null) return false;
  return (
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { model?: unknown }).model === "string" &&
    typeof (value as { provider?: unknown }).provider === "string" &&
    typeof (value as { ip?: unknown }).ip === "string" &&
    typeof (value as { startedAt?: unknown }).startedAt === "string" &&
    typeof (value as { ageMs?: unknown }).ageMs === "number"
  );
}

/**
 * SSE-driven variant of InFlightTable. Subscribes to a stream URL via
 * `useSSE` and merges incoming rows into the visible list.
 */
export interface SSEInFlightTableProps {
  streamUrl: string;
  /** Maximum rows retained in the local buffer (default 200). */
  bufferSize?: number;
  className?: string;
  maxHeight?: string;
  emptyMessage?: string;
}

export function SSEInFlightTable(props: SSEInFlightTableProps): JSX.Element {
  const [rows, setRows] = createSignal<readonly InFlightRow[]>([]);
  const [aggregate, setAggregate] = createSignal<{ inFlight: number; waiters: number; grants: number } | null>(null);
  const [status, setStatus] = createSignal<InFlightTableProps["status"]>("connecting");

  const applyUpdate = (incoming: readonly InFlightRow[]) => {
    if (incoming.length === 0) {
      setRows([]);
      return;
    }
    const seen = new Map<string, InFlightRow>();
    for (const next of incoming) {
      const existing = seen.get(next.id);
      if (!existing || next.ageMs >= existing.ageMs) {
        seen.set(next.id, next);
      }
    }
    const merged = Array.from(seen.values()).sort((a, b) => b.ageMs - a.ageMs);
    setRows(merged.slice(0, props.bufferSize ?? 200));
  };

  // Aggregate counter payloads ({"inFlight":N,"waiters":N,"grants":N,"rows":[…]})
  // from the API's in-flight stream; rows carry bounded per-request dispatch
  // records when the per-request registry is wired.
  const applyAggregate = (candidate: unknown): boolean => {
    if (typeof candidate !== "object" || candidate === null) return false;
    const record = candidate as Record<string, unknown>;
    if (typeof record.inFlight !== "number") return false;
    setAggregate({
      inFlight: record.inFlight,
      waiters: typeof record.waiters === "number" ? record.waiters : 0,
      grants: typeof record.grants === "number" ? record.grants : 0,
    });
    setStatus("connected");
    if (Array.isArray(record.rows)) {
      const rows: InFlightRow[] = [];
      for (const entry of record.rows) {
        if (typeof entry !== "object" || entry === null) continue;
        const row = entry as Record<string, unknown>;
        if (typeof row.id !== "string" || typeof row.startedAt !== "string" || typeof row.ageMs !== "number") continue;
        rows.push({
          id: row.id,
          model: typeof row.model === "string" ? row.model : "—",
          provider: typeof row.provider === "string" && row.provider ? row.provider : "—",
          ip: typeof row.ip === "string" && row.ip ? row.ip : "—",
          startedAt: row.startedAt,
          ageMs: row.ageMs,
          bytes: typeof row.bytes === "number" ? row.bytes : null,
        });
      }
      applyUpdate(rows);
    }
    return true;
  };

  const { state } = useSSE(props.streamUrl, {
    onMessage: (event) => {
      if (event.type === "snapshot" || event.type === "update") {
        applyUpdate(parseRows(event.data));
        return;
      }
      const data = event && typeof event === "object" && "data" in event ? (event as { data?: unknown }).data : event;
      applyAggregate(data);
    },
    onConnect: () => setStatus("connected"),
    onDisconnect: () => setStatus("error"),
  });

  createEffect(() => {
    const current = state();
    if (current.connected) setStatus("connected");
    else if (current.reconnecting) setStatus("connecting");
    else if (current.error) setStatus("error");
  });

  onCleanup(() => setStatus("idle"));

  return (
    <div class={cn("flex flex-col", props.className)}>
      <Show when={aggregate()}>
        {(live) => (
          <div class="flex items-center justify-between gap-2 border-b border-[var(--inner-border)] px-3 py-2 text-[11px] text-[var(--text-3)]">
            <span class="font-semibold tabular-nums text-[var(--text-2)]">
              {live().inFlight} in-flight
            </span>
            <span class="tabular-nums">{live().waiters} queued · {formatNumber(live().grants)} granted</span>
          </div>
        )}
      </Show>
      <InFlightTable
        rows={rows()}
        loading={false}
        status={status()}
        maxHeight={props.maxHeight}
        emptyMessage={props.emptyMessage}
      />
    </div>
  );
}
