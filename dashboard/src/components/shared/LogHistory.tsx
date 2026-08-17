
import { For, Show, createEffect, createMemo, type JSX } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { createResource } from "solid-js";
import { cn } from "../../lib/cn";
import { formatTime } from "../../lib/format";
import { Badge } from "../ui/badge";
import { consoleGet, consoleFailure } from "../../lib/console-api";
import { apiCache, getCacheKey } from "../../lib/cache";
import {
  type LogEntry,
  type LogLevel,
  levelMatches,
  normalizeLogEntry,
} from "./log-types";

export interface LogHistoryProps {
  level: LogLevel;
  source?: string;
  /** Initial "from" ISO timestamp; defaults to one hour ago. */
  from?: string;
  /** Initial "to" ISO timestamp; defaults to now. */
  to?: string;
  /** Maximum rows fetched from the API. */
  limit?: number;
  /** Endpoint suffix inside /console; defaults to /logs. */
  route?: string;
  className?: string;
}

const ROW_HEIGHT = 52;
const HISTORY_LIMIT = 500;

const LEVEL_TONE: Record<LogLevel, "neutral" | "info" | "warning" | "danger" | "accent"> = {
  debug: "neutral",
  info: "info",
  warn: "warning",
  error: "danger",
};

type LogHistoryResponse = {
  readonly entries?: readonly unknown[];
  readonly items?: readonly unknown[];
  readonly logs?: readonly unknown[];
};

function pickList(value: LogHistoryResponse): readonly unknown[] {
  if (Array.isArray(value.entries)) return value.entries;
  if (Array.isArray(value.items)) return value.items;
  if (Array.isArray(value.logs)) return value.logs;
  return [];
}

/**
 * Bounded historical console-log view backed by /console/logs.
 * Mirrors LogStream's filter behaviour so a single LogFilter above both panes
 * keeps level/source selection consistent across the live tail and the past.
 */
export function LogHistory(props: LogHistoryProps): JSX.Element {
  const route = (): string => props.route ?? "/logs";
  const from = () => props.from ?? new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const to = () => props.to ?? new Date().toISOString();

  const cacheKey = createMemo(() =>
    getCacheKey(route(), {
      from: from(),
      to: to(),
      limit: props.limit ?? HISTORY_LIMIT,
    }),
  );

  const [historyResource] = createResource(
    () => ({ from: from(), to: to(), limit: props.limit ?? HISTORY_LIMIT }),
    async (params) => {
      const key = cacheKey();
      const cached = apiCache.get<LogEntry[]>(key);
      if (cached) return cached;
      const query = `?from=${encodeURIComponent(params.from)}&to=${encodeURIComponent(params.to)}&limit=${params.limit}`;
      const response = await consoleGet<LogHistoryResponse>(`${route()}${query}`);
      const list = pickList(response);
      const entries: LogEntry[] = [];
      for (let index = 0; index < list.length; index += 1) {
        const normalized = normalizeLogEntry(list[index], `${route()}-${index}`);
        if (normalized) entries.push(normalized);
      }
      apiCache.set(key, entries, 60_000);
      return entries;
    },
  );

  const filtered = createMemo<LogEntry[]>(() => {
    const sourceFilter = props.source?.trim().toLowerCase();
    const list = historyResource.error ? [] : historyResource() ?? [];
    return list.filter((entry) => {
      if (!levelMatches(props.level, entry.level)) return false;
      if (sourceFilter && !entry.source.toLowerCase().includes(sourceFilter)) return false;
      return true;
    });
  });

  const failure = createMemo(() => consoleFailure(historyResource.error));

  let scrollContainer: HTMLDivElement | undefined;
  const virtualizer = createVirtualizer({
    get count() {
      return filtered().length;
    },
    getScrollElement: () => scrollContainer ?? null,
    estimateSize: () => ROW_HEIGHT,
    overscan: 6,
  });

  createEffect(() => {
    historyResource();
    if (scrollContainer && !historyResource.loading) {
      queueMicrotask(() => {
        if (!scrollContainer) return;
        if (typeof scrollContainer.scrollTo === "function") {
          scrollContainer.scrollTo({ top: scrollContainer.scrollHeight });
        } else {
          scrollContainer.scrollTop = scrollContainer.scrollHeight;
        }
      });
    }
  });

  return (
    <div class={cn("flex flex-col gap-3", props.className)}>
      <Show when={failure()}>
        {(status) => <p class="px-1 text-[11px] text-[var(--status-danger)]">{status().message}</p>}
      </Show>

      <div
        ref={scrollContainer}
        class="console-log-scroll relative h-[420px] overflow-y-auto rounded-[var(--radius-card)] border border-[var(--inner-border)] bg-[var(--surface-1)] font-mono text-[11.5px]"
        aria-label="Historical console log"
      >
        <Show
          when={!historyResource.loading}
          fallback={
            <div class="flex h-full items-center justify-center text-[var(--text-3)]">Loading history…</div>
          }
        >
          <Show
            when={filtered().length > 0}
            fallback={
              <div class="flex h-full items-center justify-center text-[var(--text-3)]">
                {failure() ? failure()!.message : "No log entries match the current filter."}
              </div>
            }
          >
            <div
              style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}
            >
              <For each={virtualizer.getVirtualItems()}>
                {(virtualRow) => {
                  const entry = (): LogEntry | undefined => filtered()[virtualRow.index];
                  return (
                    <Show when={entry()}>
                      {(current) => (
                        <div
                          class="log-entry-fade-in flex items-start gap-3 border-b border-[var(--inner-border)] px-3 py-2 transition-colors duration-150 hover:bg-[var(--hover)]"
                          style={{
                            position: "absolute",
                            top: `${virtualRow.start}px`,
                            left: 0,
                            right: 0,
                            height: `${ROW_HEIGHT}px`,
                          }}
                        >
                          <Badge tone={LEVEL_TONE[current().level]}>{current().level.toUpperCase()}</Badge>
                          <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                            <div class="flex flex-wrap items-baseline gap-2 text-[10.5px] text-[var(--text-3)]">
                              <span class="tabular-nums">{formatTime(current().timestamp)}</span>
                              <span class="truncate font-semibold text-[var(--text-2)]">{current().source}</span>
                            </div>
                            <div class="truncate text-[11.5px] text-[var(--text-1)]" title={current().message}>
                              {current().message}
                            </div>
                          </div>
                        </div>
                      )}
                    </Show>
                  );
                }}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
}


