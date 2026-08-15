/* @jsxImportSource solid-js */

import { cn } from "../../lib/cn";

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
export function ProgressBar({ value, max = 100, tone = "accent", label, showValue = false, className }: ProgressBarProps) {
  const normalizedMax = Number.isFinite(max) && max > 0 ? max : 100;
  const normalizedValue = Number.isFinite(value) ? Math.min(normalizedMax, Math.max(0, value ?? 0)) : 0;
  const percentage = (normalizedValue / normalizedMax) * 100;
  return (
    <div class={cn("min-w-0", className)}>
      {(label || showValue) && (
        <div class="mb-1 flex items-center justify-between gap-2 text-[10px] text-[var(--text-3)]">
          {label && <span class="truncate">{label}</span>}
          {showValue && <span class="tabular-nums">{Math.round(percentage)}%</span>}
        </div>
      )}
      <div class="h-1.5 overflow-hidden rounded-full bg-[var(--track)]" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={normalizedMax} aria-valuenow={normalizedValue}>
        <div class={cn("h-full origin-left rounded-full transition-transform duration-500", toneClasses[tone])} style={{ transform: `scaleX(${percentage / 100})` }} />
      </div>
    </div>
  );
}
