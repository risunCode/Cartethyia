
import { cn } from "@lib/cn";

export interface ProgressBarProps {
  value: number | null | undefined;
  max?: number;
  tone?: "accent" | "success" | "warning" | "danger" | "info";
  label?: string;
  showValue?: boolean;
  className?: string;
}

const toneClasses: Record<NonNullable<ProgressBarProps["tone"]>, string> = {
  accent: "bg-[var(--accent)]",
  success: "bg-[var(--status-success)]",
  warning: "bg-[var(--status-warning)]",
  danger: "bg-[var(--status-danger)]",
  info: "bg-[var(--status-info)]",
};

/** Renders an accessible bounded progress indicator shared by health and quota cards. */
// Props stay wrapped in the `props` object (no destructuring) so live value/max
// updates keep re-rendering under Solid's fine-grained reactivity.
export function ProgressBar(props: ProgressBarProps) {
  const normalizedMax = () =>
    typeof props.max === "number" && Number.isFinite(props.max) && props.max > 0 ? props.max : 100;
  const normalizedValue = () =>
    typeof props.value === "number" && Number.isFinite(props.value)
      ? Math.min(normalizedMax(), Math.max(0, props.value))
      : 0;
  const percentage = () => (normalizedValue() / normalizedMax()) * 100;
  return (
    <div class={cn("min-w-0", props.className)}>
      {(props.label || props.showValue) && (
        <div class="mb-1 flex items-center justify-between gap-2 text-[10px] text-[var(--text-3)]">
          {props.label && <span class="truncate">{props.label}</span>}
          {props.showValue && <span class="tabular-nums">{Math.round(percentage())}%</span>}
        </div>
      )}
      <div class="h-1.5 overflow-hidden rounded-full bg-[var(--track)]" role="progressbar" aria-label={props.label} aria-valuemin={0} aria-valuemax={normalizedMax()} aria-valuenow={normalizedValue()}>
        <div class={cn("bar-transition h-full origin-left rounded-full", toneClasses[props.tone ?? "accent"])} style={{ transform: `scaleX(${percentage() / 100})` }} />
      </div>
    </div>
  );
}
