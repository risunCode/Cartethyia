/* @jsxImportSource solid-js */

import { splitProps, type JSX } from "solid-js";
import { cn } from "../../lib/cn";

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info" | "accent" | "default" | "ok" | "err" | "warn";

const semanticTones: Record<Exclude<BadgeTone, "default" | "ok" | "err" | "warn">, string> = {
  neutral: "bg-[var(--hover)] text-[var(--text-2)] border-[var(--inner-border)]",
  success: "bg-[var(--green-soft)] text-[var(--status-success)] border-transparent",
  warning: "bg-[var(--orange-soft)] text-[var(--status-warning)] border-transparent",
  danger: "bg-[var(--red-soft)] text-[var(--status-danger)] border-transparent",
  info: "bg-[var(--teal-soft)] text-[var(--status-info)] border-transparent",
  accent: "bg-[var(--accent-soft)] text-[var(--accent)] border-transparent",
};

const tones: Record<BadgeTone, string> = {
  ...semanticTones,
  default: semanticTones.neutral,
  ok: semanticTones.success,
  err: semanticTones.danger,
  warn: semanticTones.warning,
};

export interface BadgeProps extends JSX.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  className?: string;
}

/** A compact status label with the dashboard's semantic color palette. */
export function Badge(props: BadgeProps): JSX.Element {
  const [local, rest] = splitProps(props, ["className", "tone"]);
  return <span {...rest} class={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10.5px] font-semibold", tones[local.tone ?? "default"], local.className)} />;
}

export interface SkeletonProps {
  className?: string;
}

/** A non-interactive loading placeholder. */
export function Skeleton(props: SkeletonProps): JSX.Element {
  return <div aria-hidden="true" class={cn("skeleton h-4 w-full", props.className)} />;
}
