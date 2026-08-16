
import { For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { Card, CardHeader } from "../ui/card";
import { Badge } from "../ui/badge";
import { DataTable } from "../ui/layout";
import { Skeleton } from "../ui/badge";
import { AlertTriangle } from "lucide-solid";
import { formatRelativeTime, formatTime } from "../../lib/format";
import { cn } from "../../lib/cn";

export interface ErrorListItem {
  id: string;
  code: string;
  message: string;
  source: string;
  timestamp: string;
  count?: number;
  severity?: "info" | "warning" | "error";
}

export interface ErrorListProps {
  errors: readonly ErrorListItem[];
  loading?: boolean;
  emptyMessage?: string;
  limit?: number;
  className?: string;
  onItemClick?: (item: ErrorListItem) => void;
}

const SEVERITY_TONE: Record<NonNullable<ErrorListItem["severity"]>, "info" | "warn" | "err"> = {
  info: "info",
  warning: "warn",
  error: "err",
};

/**
 * ErrorList — last-N error log table. Uses solidcn-ui DataTable + Badge.
 * Compact, monospace source column, clickable rows for navigation.
 */
export function ErrorList(props: ErrorListProps): JSX.Element {
  const visibleItems = (): readonly ErrorListItem[] => {
    if (typeof props.limit === "number") {
      return props.errors.slice(0, props.limit);
    }
    return props.errors;
  };

  return (
    <Card density="compact" className={cn("animate-fade-in min-w-0", props.className)}>
      <CardHeader title="Recent errors" icon={AlertTriangle} iconColor="#ff453a" sub={`${props.errors.length} entries`} />
      <Show
        when={!props.loading}
        fallback={
          <div class="space-y-2" aria-label="Loading errors">
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
              {props.emptyMessage ?? "No recent errors — API is healthy."}
            </p>
          }
        >
          <DataTable minWidth={520} label="Recent errors">
            <thead>
              <tr class="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">
                <th scope="col" class="px-2 py-2 text-left">Time</th>
                <th scope="col" class="px-2 py-2 text-left">Code</th>
                <th scope="col" class="px-2 py-2 text-left">Source</th>
                <th scope="col" class="px-2 py-2 text-left">Message</th>
                <th scope="col" class="px-2 py-2 text-right">Count</th>
              </tr>
            </thead>
            <tbody>
              <For each={visibleItems()}>
                {(item) => {
                  const severity = item.severity ?? "error";
                  return (
                    <tr
                      class={cn(
                        "border-t border-[var(--inner-border)] transition-colors duration-150 hover:bg-[var(--hover)]",
                        props.onItemClick && "cursor-pointer focus-visible:bg-[var(--hover)] focus-visible:outline-none",
                      )}
                      tabIndex={props.onItemClick ? 0 : -1}
                      role={props.onItemClick ? "button" : undefined}
                      aria-label={props.onItemClick ? `${item.code}: ${item.message}` : undefined}
                      onClick={() => props.onItemClick?.(item)}
                      onKeyDown={(event) => {
                        if (!props.onItemClick) return;
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          props.onItemClick(item);
                        }
                      }}
                    >
                      <td class="px-2 py-1.5 text-[11px] tabular-nums text-[var(--text-2)]" title={formatTime(item.timestamp)}>
                        {formatRelativeTime(item.timestamp)}
                      </td>
                      <td class="px-2 py-1.5">
                        <Badge tone={SEVERITY_TONE[severity]} className="font-mono text-[10px]">
                          {item.code}
                        </Badge>
                      </td>
                      <td class="px-2 py-1.5 font-mono text-[11px] text-[var(--text-2)]">{item.source}</td>
                      <td class="max-w-[420px] truncate px-2 py-1.5 text-[11px] text-[var(--text-1)]" title={item.message}>
                        {item.message}
                      </td>
                      <td class="px-2 py-1.5 text-right text-[11px] tabular-nums text-[var(--text-2)]">{item.count ?? 1}</td>
                    </tr>
                  );
                }}
              </For>
            </tbody>
          </DataTable>
        </Show>
      </Show>
    </Card>
  );
}
