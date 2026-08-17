
import { For, Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { useSSE } from "@lib/sse";
import { cn } from "@lib/cn";
import { formatTime } from "@lib/format";
import { Badge } from "../ui/badge";
import {
  type LogEntry,
  type LogLevel,
  levelMatches,
  normalizeLogEntry,
} from "@lib/log-types";

export interface LogStreamProps {
  url: string;
  level: LogLevel;
  source?: string;
  /** Maximum entries retained in the rolling buffer; default 1000. */
  bufferSize?: number;
  /** Pause auto-scroll while user inspects older entries. */
  autoScroll?: boolean;
  className?: string;
}

const STREAM_BUFFER_DEFAULT = 1000;
const ROW_HEIGHT = 56;

const LEVEL_TONE: Record<LogLevel, "neutral" | "info" | "warning" | "danger" | "accent"> = {
  debug: "neutral",
  info: "info",
  warn: "warning",
  error: "danger",
};

let entryCounter = 0;

/**
 * Live console-log tail driven by SSE (via lib/sse.ts). Maintains a bounded
 * rolling buffer (default 1000) of normalized LogEntry rows, applies the
 * current level/source filter, and renders through TanStack Virtual so the
 * table stays interactive regardless of buffer depth.
 */
export function LogStream(props: LogStreamProps): JSX.Element {
  const bufferSize = (): number => props.bufferSize ?? STREAM_BUFFER_DEFAULT;
  const [entries, setEntries] = createSignal<LogEntry[]>([]);
  const [autoScroll, setAutoScroll] = createSignal(props.autoScroll ?? true);
  const [pausedAt, setPausedAt] = createSignal<number | null>(null);
  let scrollContainer: HTMLDivElement | undefined;

  const filtered = createMemo<LogEntry[]>(() => {
    const sourceFilter = props.source?.trim().toLowerCase();
    return entries().filter((entry) => {
      if (!levelMatches(props.level, entry.level)) return false;
      if (sourceFilter && !entry.source.toLowerCase().includes(sourceFilter)) return false;
      return true;
    });
  });

  const virtualizer = createVirtualizer({
    get count() {
      return filtered().length;
    },
    getScrollElement: () => scrollContainer ?? null,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  const connection = useSSE(props.url, {
    onMessage: (event) => {
      let candidate: unknown = event;
      if (event && typeof event === "object" && "data" in event) {
        candidate = event.data;
      }
      entryCounter += 1;
      const fallbackId = `sse-${Date.now().toString(36)}-${entryCounter}`;
      const entry = normalizeLogEntry(candidate, fallbackId);
      if (!entry) return;
      setEntries((current) => {
        const overflow = current.length + 1 - bufferSize();
        const trimmed = overflow > 0 ? current.slice(overflow) : current.slice();
        trimmed.push(entry);
        return trimmed;
      });
    },
  });

  // Detect scroll position so a manual scroll-up pauses auto-follow, while
  // a return to the bottom edge resumes it.
  createEffect(() => {
    const container = scrollContainer;
    if (!container) return;
    const handler = () => {
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      const isPinned = distanceFromBottom < ROW_HEIGHT * 2;
      setAutoScroll((current) => (current === isPinned ? current : isPinned));
      if (isPinned && pausedAt() !== null) setPausedAt(null);
    };
    container.addEventListener("scroll", handler, { passive: true });
    onCleanup(() => container.removeEventListener("scroll", handler));
  });

  // Auto-scroll on new entries when pinned to the bottom; smooth-scroll is
  // configured via .console-log-scroll so transitions land at 300ms.
  createEffect(() => {
    filtered();
    if (!autoScroll()) {
      if (pausedAt() === null) setPausedAt(Date.now());
      return;
    }
    const container = scrollContainer;
    if (!container) return;
    queueMicrotask(() => {
      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
    });
  });

  const handleResume = () => {
    setAutoScroll(true);
    setPausedAt(null);
    const container = scrollContainer;
    if (container) container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  };

  const virtualItems = createMemo(() => virtualizer.getVirtualItems());
  const totalSize = createMemo(() => virtualizer.getTotalSize());

  return (
    <div class={cn("flex flex-col gap-2", props.className)}>
      <div class="flex flex-wrap items-center justify-between gap-2 px-1 text-[11px] text-[var(--text-3)]">
        <div class="flex items-center gap-2">
          <span
            class={cn(
              "inline-block h-1.5 w-1.5 rounded-full",
              connection.state().connected
                ? "bg-[var(--status-success)]"
                : connection.state().reconnecting
                ? "bg-[var(--status-warning)]"
                : "bg-[var(--status-danger)]",
            )}
            aria-hidden="true"
          />
          <span>
          {connection.state().connected
            ? "Streaming"
            : connection.state().reconnecting
            ? "Reconnecting…"
            : "Disconnected"}
            {" · "}
            {filtered().length} / {entries().length} entries (buffer {bufferSize()})
          </span>
        </div>
        <Show when={!autoScroll() && pausedAt() !== null}>
          <button
            type="button"
            onClick={handleResume}
            class="rounded-full border border-[var(--inner-border)] bg-[var(--hover)] px-3 py-1 text-[11px] font-semibold text-[var(--accent)] transition-colors duration-150 hover:bg-[var(--active-pill)]"
          >
            Resume auto-scroll
          </button>
        </Show>
      </div>

      <div
        ref={scrollContainer}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Live console log stream"
        class="console-log-scroll log-zebra relative h-[480px] overflow-y-auto rounded-[var(--radius-card)] border border-[var(--inner-border)] bg-[var(--surface-1)] font-mono text-[11.5px]"
      >
        <Show
          when={filtered().length > 0}
          fallback={
            <div class="flex h-full items-center justify-center text-[var(--text-3)]">
              {connection.state().connected ? "Waiting for log entries…" : "Stream offline"}
            </div>
          }
        >
          <div style={{ height: `${totalSize()}px`, position: "relative", width: "100%" }}>
            <For each={virtualItems()}>
              {(virtualRow) => {
                const entry = (): LogEntry | undefined => filtered()[virtualRow.index];
                return (
                  <Show when={entry()}>
                    {(current) => <LogRow entry={current()} top={virtualRow.start} />}
                  </Show>
                );
              }}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}

interface LogRowProps {
  entry: LogEntry;
  top: number;
}

function LogRow(props: LogRowProps): JSX.Element {
  const tone = (): "neutral" | "info" | "warning" | "danger" | "accent" => LEVEL_TONE[props.entry.level];
  return (
    <div
      class="log-entry-fade-in flex items-start gap-3 border-b border-[var(--inner-border)] px-3 py-2 transition-colors duration-150 hover:bg-[var(--hover)]"
      style={{ position: "absolute", top: `${props.top}px`, left: 0, right: 0, height: `${ROW_HEIGHT}px` }}
    >
      <Badge tone={tone()}>{props.entry.level.toUpperCase()}</Badge>
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <div class="flex flex-wrap items-baseline gap-2 text-[10.5px] text-[var(--text-3)]">
          <span class="tabular-nums">{formatTime(props.entry.timestamp)}</span>
          <span class="truncate font-semibold text-[var(--text-2)]">{props.entry.source}</span>
        </div>
        <div class="truncate text-[11.5px] text-[var(--text-1)]" title={props.entry.message}>
          {props.entry.message}
        </div>
      </div>
    </div>
  );
}
