
import type { JSX } from "solid-js";
import { For, Show, createMemo } from "solid-js";
import { Loader2 } from "lucide-solid";
import { Card, type CardDensity } from "../ui/card";
import { Skeleton } from "../ui/badge";
import { IconBadge, type IconTone } from "../ui/icon";
import { cn } from "../../lib/cn";

export type LoadingStateVariant = "spinner" | "skeleton" | "block";

export interface LoadingStateProps {
  /** Visual variant. Defaults to "spinner" for inline, "skeleton" for lists. */
  variant?: LoadingStateVariant;
  /** Accessible label announced by the loading region. */
  label?: string;
  /** Optional helper copy shown beneath the spinner. */
  description?: string;
  /** Number of skeleton rows to render (skeleton / block variant). */
  rows?: number;
  /** Approximate height per skeleton row in tailwind units (e.g. "h-4"). */
  rowHeight?: string;
  /** Wraps the loader in a Card. Default true for skeleton, false for spinner. */
  framed?: boolean;
  /** Card density when framed. */
  density?: CardDensity;
  /** Tone for the spinner icon badge. Defaults to "accent". */
  tone?: IconTone;
  className?: string;
}

/**
 * LoadingState — a unified loading primitive with three variants:
 *  - "spinner": a small inline spinner with optional copy.
 *  - "skeleton": a stack of skeleton bars (defaults to 3 rows).
 *  - "block":   a single solid block (e.g. for chart placeholders).
 */
export function LoadingState(props: LoadingStateProps): JSX.Element {
  const variant = (): LoadingStateVariant => props.variant ?? "spinner";
  const label = (): string => props.label ?? "Loading";
  const rows = (): number => Math.max(0, props.rows ?? 3);
  const rowHeight = (): string => props.rowHeight ?? "h-4";
  const tone = (): IconTone => props.tone ?? "accent";
  const framed = (): boolean => {
    if (props.framed !== undefined) return props.framed;
    return variant() === "skeleton";
  };

  const skeletonLines = createMemo(() => Array.from({ length: rows() }, (_, index) => index));

  const SpinnerBody = (): JSX.Element => (
    <div class="flex items-center gap-2.5" role="status" aria-live="polite" aria-busy="true">
      <IconBadge icon={Loader2} tone={tone()} size="md" class="component-spin" aria-hidden="true" />
      <div class="min-w-0">
        <div class="text-sm font-semibold text-[var(--text-1)]">{label()}</div>
        <Show when={props.description}>
          {(description) => <div class="text-xs text-[var(--text-3)]">{description()}</div>}
        </Show>
      </div>
    </div>
  );

  const SkeletonBody = (): JSX.Element => (
    <div role="status" aria-live="polite" aria-busy="true" aria-label={label()} class="space-y-2">
      <For each={skeletonLines()}>
        {(index) => (
          <Skeleton className={cn(rowHeight(), index === 0 && "w-3/4", index === skeletonLines().length - 1 && "w-1/2")} />
        )}
      </For>
      <span class="sr-only">{label()}</span>
    </div>
  );

  const BlockBody = (): JSX.Element => (
    <div role="status" aria-live="polite" aria-busy="true" aria-label={label()} class={cn("w-full animate-pulse rounded-[var(--radius-md)] bg-[var(--surface-muted)]", rowHeight())}>
      <span class="sr-only">{label()}</span>
    </div>
  );

  const body = (): JSX.Element => {
    switch (variant()) {
      case "skeleton":
        return <SkeletonBody />;
      case "block":
        return <BlockBody />;
      case "spinner":
      default:
        return <SpinnerBody />;
    }
  };

  if (!framed()) {
    return <div class={cn("component-fade-in", props.className)}>{body()}</div>;
  }

  return (
    <Card density={props.density ?? "default"} className={cn("component-fade-in", props.className)}>
      {body()}
    </Card>
  );
}
