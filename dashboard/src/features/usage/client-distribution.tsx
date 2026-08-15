/* @jsxImportSource solid-js */

import { Card, CardHeader } from "../../components/ui/card";
import { Show, For, createMemo, createUniqueId } from "solid-js";

export interface ClientDistributionItem {
  readonly family: string;
  readonly label: string;
  readonly count: number;
  readonly percentage: number;
  readonly tone: string;
  readonly source?: string | null;
  readonly confidence?: string | null;
}

interface ClientDistributionProps {
  readonly items: readonly ClientDistributionItem[];
  readonly total: number | null;
  readonly unknownCount: number | null;
  readonly isLoading?: boolean;
}

function boundedPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function formatCount(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(Math.max(0, value));
}

/** Renders daemon-provided client-family metadata while keeping unknown requests in the denominator. */
export function ClientDistribution(props: ClientDistributionProps) {
  const labelId = `client-distribution-${createUniqueId()}`;
  const visibleItems = createMemo(() => props.items.filter((item) => item.count > 0 && boundedPercentage(item.percentage) > 0));
  const safeTotal = () => props.total === null ? null : Math.max(0, props.total);
  const safeUnknown = () => props.unknownCount === null ? null : Math.max(0, props.unknownCount);
  const unknownDetails = () => safeUnknown() === null ? "Unknown client total unavailable" : `Unknown: ${formatCount(safeUnknown()!)}`;

  return <Card><CardHeader title="Client distribution" sub="Bounded client-family metadata across canonical requests" />
    <Show when={!props.isLoading} fallback={<div class="h-24 animate-pulse rounded-xl bg-[var(--surface-muted)]" aria-label="Loading client distribution" />}>
      <div class="space-y-4" aria-labelledby={labelId}><span id={labelId} class="sr-only">Client distribution totals</span>
        <Show when={safeTotal() !== null} fallback={<p class="rounded-xl border border-dashed border-[var(--inner-border)] px-3 py-4 text-xs text-[var(--text-3)]" role="status">Client distribution is unavailable from the daemon.</p>}>
          <div class="flex h-3 overflow-hidden rounded-full bg-[var(--surface-muted)]" role="img" aria-label={`${formatCount(safeTotal()!)} requests distributed across detected and unknown clients`}><For each={visibleItems()}>{(item) => <span class="min-w-0 transition-[width] duration-300" style={{ width: `${boundedPercentage(item.percentage)}%`, "background-color": item.tone }} title={`${item.label}: ${formatCount(item.count)} (${boundedPercentage(item.percentage).toFixed(1)}%)${item.source ? ` · source ${item.source}` : ""}${item.confidence ? ` · confidence ${item.confidence}` : ""}`} />}</For></div>
          <div class="grid gap-2 sm:grid-cols-2"><For each={props.items}>{(item) => <div class="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-[var(--inner-border)] px-3 py-2 text-xs" title={`${item.source ? `Source: ${item.source}` : "Source unavailable"} · ${item.confidence ? `Confidence: ${item.confidence}` : "Confidence unavailable"}`}><span class="flex min-w-0 items-center gap-2"><span class="h-2 w-2 shrink-0 rounded-full" style={{ "background-color": item.tone }} aria-hidden="true" /><span class="truncate text-[var(--text-1)]">{item.label}</span></span><span class="shrink-0 tabular-nums text-[var(--text-2)]">{formatCount(item.count)} · {boundedPercentage(item.percentage).toFixed(1)}%</span></div>}</For><div class="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-dashed border-[var(--inner-border)] px-3 py-2 text-xs" title={unknownDetails()}><span class="text-[var(--text-2)]">Unknown</span><span class="shrink-0 tabular-nums text-[var(--text-2)]">{safeUnknown() === null ? "—" : formatCount(safeUnknown()!)}</span></div></div>
          <p class="text-[11px] text-[var(--text-3)]">Total requests: {formatCount(safeTotal()!)}. Percentages include unknown client origin.</p>
        </Show>
      </div>
    </Show>
  </Card>;
}
