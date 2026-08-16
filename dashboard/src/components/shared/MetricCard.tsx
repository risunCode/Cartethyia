
import type { JSX } from "solid-js";
import type { LucideIcon } from "lucide-solid";
import { Card } from "../ui/card";
import { StatCard, type StatCardProps } from "../ui/state";
import { cn } from "../../lib/cn";

export interface MetricCardProps {
  label: string;
  value: JSX.Element | string | number;
  description?: string;
  icon?: LucideIcon;
  tone?: StatCardProps["tone"];
  loading?: boolean;
  trend?: "up" | "down" | "flat";
  trendLabel?: string;
  className?: string;
}

const TREND_GLYPH: Record<NonNullable<MetricCardProps["trend"]>, string> = {
  up: "▲",
  down: "▼",
  flat: "—",
};

const TREND_TONE: Record<NonNullable<MetricCardProps["trend"]>, string> = {
  up: "text-[var(--status-success)]",
  down: "text-[var(--status-danger)]",
  flat: "text-[var(--text-3)]",
};

/**
 * MetricCard — primary overview KPI tile. Wraps solidcn-ui StatCard with
 * fade-in animation and an optional trend indicator.
 */
export function MetricCard(props: MetricCardProps): JSX.Element {
  const renderedValue: JSX.Element = typeof props.value === "string" || typeof props.value === "number" ? (
    <span class="tabular-nums">{props.value}</span>
  ) : (
    props.value
  );

  return (
    <div class="animate-fade-in">
      <StatCard
        label={props.label}
        value={renderedValue}
        description={props.description}
        icon={props.icon}
        tone={props.tone}
        loading={props.loading === true}
        className={cn("min-w-0 transition-transform duration-200 ease-out hover:-translate-y-0.5", props.className)}
      />
      {props.trendLabel && (
        <div class={cn("mt-1 flex items-center gap-1 px-1 text-[10px] font-medium tabular-nums", TREND_TONE[props.trend ?? "flat"])}>
          <span aria-hidden="true">{TREND_GLYPH[props.trend ?? "flat"]}</span>
          <span>{props.trendLabel}</span>
        </div>
      )}
    </div>
  );
}

const METRIC_GRID_COLUMNS: Record<2 | 3 | 4 | 6, string> = {
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
  4: "grid-cols-2 lg:grid-cols-4",
  6: "grid-cols-2 md:grid-cols-3 lg:grid-cols-6",
};

export interface MetricGridProps {
  children: JSX.Element;
  columns?: 2 | 3 | 4 | 6;
  className?: string;
}

/** A responsive grid wrapper for MetricCard lists. */
export function MetricGrid(props: MetricGridProps): JSX.Element {
  return <div class={cn("grid gap-3", METRIC_GRID_COLUMNS[props.columns ?? 4], props.className)}>{props.children}</div>;
}

export interface MetricCardSkeletonProps {
  label?: string;
  className?: string;
}

/** Loading placeholder for MetricCard. */
export function MetricCardSkeleton(props: MetricCardSkeletonProps): JSX.Element {
  return (
    <Card density="compact" className={cn("animate-fade-in min-w-0", props.className)}>
      <div class="h-3 w-20 animate-pulse rounded bg-[var(--surface-muted)]" />
      <div class="mt-2 h-6 w-24 animate-pulse rounded bg-[var(--surface-muted)]" />
      <div class="mt-1 h-2 w-32 animate-pulse rounded bg-[var(--surface-muted)]" />
      <span class="sr-only">{props.label ?? "Loading metric"}</span>
    </Card>
  );
}
