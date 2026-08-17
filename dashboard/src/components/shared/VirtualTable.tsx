
import { For, Show, createEffect, createMemo, onCleanup, type JSX } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import type { LucideIcon } from "lucide-solid";
import { Card, CardHeader } from "../ui/card";
import { Badge } from "../ui/badge";
import { Skeleton } from "../ui/badge";
import { cn } from "@lib/cn";

export interface VirtualTableColumn<T> {
  key: string;
  label: string;
  width?: string;
  align?: "left" | "right" | "center";
  render: (item: T, index: number) => JSX.Element;
}

export interface VirtualTableProps<T> {
  items: readonly T[];
  columns: readonly VirtualTableColumn<T>[];
  rowKey: (item: T, index: number) => string;
  rowHeight?: number;
  pageSize?: number;
  maxHeight?: string;
  loading?: boolean;
  title?: string;
  subtitle?: string;
  icon?: LucideIcon;
  iconColor?: string;
  /** When provided, called when the user scrolls near the end of the rendered list. */
  onLoadMore?: () => void;
  hasMore?: boolean;
  emptyMessage?: string;
  className?: string;
  headerActions?: JSX.Element;
  /** Accessible label for the table region. */
  ariaLabel?: string;
}

/**
 * VirtualTable — high-density table using TanStack Virtual. Auto-paginates
 * in `pageSize` increments when the scroll approaches the bottom, replacing
 * the conventional "Load more" button with infinite scroll.
 */
export function VirtualTable<T>(props: VirtualTableProps<T>): JSX.Element {
  let scrollElement: HTMLDivElement | null = null;
  const rowHeight = () => props.rowHeight ?? 36;
  const pageSize = () => props.pageSize ?? 25;
  const overscan = 6;

  const visibleCount = createMemo(() => Math.min(props.items.length, pageSize()));
  const visibleItems = createMemo(() => props.items.slice(0, visibleCount()));

  const virtualizer = createMemo(() =>
    createVirtualizer({
      count: visibleItems().length,
      getScrollElement: () => scrollElement,
      estimateSize: () => rowHeight(),
      overscan,
    }),
  );

  const virtualItems = createMemo(() => virtualizer().getVirtualItems());
  const totalSize = createMemo(() => virtualizer().getTotalSize());

  const topPadding = createMemo(() => virtualItems()[0]?.start ?? 0);
  const bottomPadding = createMemo(() => {
    const last = virtualItems().at(-1);
    return last ? Math.max(0, totalSize() - last.end) : 0;
  });

  const handleScroll = (event: Event) => {
    const target = event.currentTarget as HTMLDivElement;
    if (!target) return;
    if (visibleCount() >= props.items.length && !props.hasMore) return;
    const scrollBottom = target.scrollTop + target.clientHeight;
    if (scrollBottom >= target.scrollHeight - target.clientHeight * 2) {
      props.onLoadMore?.();
    }
  };

  createEffect(() => {
    visibleItems().length;
    virtualizer()._willUpdate();
  });

  onCleanup(() => {
    scrollElement = null;
  });

  return (
    <Card density="compact" className={cn("animate-fade-in flex min-w-0 flex-col", props.className)}>
      <Show when={props.title}>
        <CardHeader title={props.title ?? ""} sub={props.subtitle} icon={props.icon} iconColor={props.iconColor}>
          {props.headerActions}
        </CardHeader>
      </Show>
      <Show
        when={!props.loading || visibleItems().length > 0}
        fallback={
          <div class="space-y-2" aria-label="Loading rows">
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
              {props.emptyMessage ?? "No data yet."}
            </p>
          }
        >
          <div
            ref={(element) => { scrollElement = element; }}
            class="relative max-w-full overflow-auto"
            style={{ "max-height": props.maxHeight ?? "480px" }}
            onScroll={handleScroll}
            role="region"
            aria-label={props.ariaLabel ?? props.title ?? "Virtual scroll table"}
            tabIndex={0}
          >
            <table class="vtable-sticky vtable-zebra w-full border-collapse text-left text-xs" style={{ "min-width": "640px" }}>
              <thead>
                <tr class="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">
                  <For each={props.columns}>
                    {(column) => (
                      <th
                        scope="col"
                        class="px-2 py-2"
                        classList={{
                          "text-left": column.align !== "right" && column.align !== "center",
                          "text-right": column.align === "right",
                          "text-center": column.align === "center",
                        }}
                        style={column.width ? { width: column.width, "min-width": column.width } : undefined}
                      >
                        {column.label}
                      </th>
                    )}
                  </For>
                </tr>
              </thead>
              <tbody>
                <Show when={topPadding() > 0}>
                  <tr aria-hidden="true">
                    <td colspan={props.columns.length} style={{ height: `${topPadding()}px`, padding: 0, border: "none" }} />
                  </tr>
                </Show>
                <For each={virtualItems()}>
                  {(virtualRow) => {
                    const item = visibleItems()[virtualRow.index];
                    if (item === undefined) return null;
                    return (
                      <tr
                        class="border-t border-[var(--inner-border)] transition-colors duration-150 hover:bg-[var(--hover)]"
                        style={{ height: `${rowHeight()}px` }}
                        data-row-key={props.rowKey(item, virtualRow.index)}
                      >
                        <For each={props.columns}>
                          {(column) => (
                            <td
                              class="px-2 align-middle text-[11px]"
                              classList={{
                                "text-left": column.align !== "right" && column.align !== "center",
                                "text-right": column.align === "right",
                                "text-center": column.align === "center",
                              }}
                              style={column.width ? { width: column.width, "min-width": column.width } : undefined}
                            >
                              {column.render(item, virtualRow.index)}
                            </td>
                          )}
                        </For>
                      </tr>
                    );
                  }}
                </For>
                <Show when={bottomPadding() > 0}>
                  <tr aria-hidden="true">
                    <td colspan={props.columns.length} style={{ height: `${bottomPadding()}px`, padding: 0, border: "none" }} />
                  </tr>
                </Show>
              </tbody>
            </table>
          </div>
          <Show when={props.hasMore || visibleCount() < props.items.length}>
            <div class="mt-2 flex items-center justify-between px-2 text-[10px] text-[var(--text-3)]">
              <span class="tabular-nums">
                Showing {visibleCount()} of {props.items.length}
              </span>
              <Badge tone="info">Loading more on scroll</Badge>
            </div>
          </Show>
        </Show>
      </Show>
    </Card>
  );
}
