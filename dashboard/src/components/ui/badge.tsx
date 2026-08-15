/* @jsxImportSource solid-js */

import { splitProps, type JSX } from "solid-js";
import { cn } from "../../lib/cn";

type Tone = "default" | "ok" | "err" | "warn" | "info" | "accent";

const tones: Record<Tone, string> = {
  default: "bg-[var(--hover)] text-[var(--text-2)] border-[var(--inner-border)]",
  ok: "bg-[var(--green-soft)] text-[var(--green)] border-transparent",
  err: "bg-[var(--red-soft)] text-[var(--red)] border-transparent",
  warn: "bg-[var(--orange-soft)] text-[var(--orange)] border-transparent",
  info: "bg-[var(--teal-soft)] text-[var(--teal)] border-transparent",
  accent: "bg-[var(--accent-soft)] text-[var(--accent)] border-transparent",
};

export interface BadgeProps extends JSX.HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
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
