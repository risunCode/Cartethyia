/* @jsxImportSource solid-js */

import { splitProps, type JSX } from "solid-js";
import type { LucideIcon } from "lucide-solid";
import { cn } from "../../lib/cn";
import type { ButtonVariant, ButtonSize } from "./button";
import { Button } from "./button";

export type IconTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";
export type IconSize = "xs" | "sm" | "md" | "lg";

const badgeSizes: Record<IconSize, string> = {
  xs: "h-6 w-6 [&>svg]:size-3",
  sm: "h-7 w-7 [&>svg]:size-3.5",
  md: "h-8 w-8 [&>svg]:size-4",
  lg: "h-10 w-10 [&>svg]:size-5",
};

const toneClasses: Record<IconTone, string> = {
  neutral: "bg-[var(--surface-muted)] text-[var(--text-secondary)]",
  accent: "bg-[var(--accent-soft)] text-[var(--accent)]",
  success: "bg-[color-mix(in_srgb,var(--status-success)_14%,transparent)] text-[var(--status-success)]",
  warning: "bg-[color-mix(in_srgb,var(--status-warning)_14%,transparent)] text-[var(--status-warning)]",
  danger: "bg-[color-mix(in_srgb,var(--status-danger)_14%,transparent)] text-[var(--status-danger)]",
  info: "bg-[color-mix(in_srgb,var(--status-info)_14%,transparent)] text-[var(--status-info)]",
};

export interface IconBadgeProps extends JSX.HTMLAttributes<HTMLSpanElement> {
  icon: LucideIcon;
  tone?: IconTone;
  size?: IconSize;
  label?: string;
  className?: string;
}

/** Renders an icon in a semantic, consistently sized badge. */
export function IconBadge(props: IconBadgeProps): JSX.Element {
  const [local, rest] = splitProps(props, ["icon", "tone", "size", "label", "className"]);
  const Icon = local.icon;
  return (
    <span {...rest} class={cn("inline-flex shrink-0 items-center justify-center rounded-full", badgeSizes[local.size ?? "md"], toneClasses[local.tone ?? "accent"], local.className)} aria-label={local.label}>
      <Icon aria-hidden={local.label === undefined ? "true" : undefined} />
    </span>
  );
}

export interface IconButtonProps extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children"> {
  icon: LucideIcon;
  label: string;
  size?: ButtonSize;
  variant?: ButtonVariant;
  className?: string;
}

/** A button whose accessible name is supplied by its icon label. */
export function IconButton(props: IconButtonProps): JSX.Element {
  const [local, rest] = splitProps(props, ["icon", "label", "size", "variant"]);
  const Icon = local.icon;
  return (
    <Button {...rest} type="button" aria-label={local.label} size={local.size ?? "icon"} variant={local.variant ?? "ghost"}>
      <Icon aria-hidden="true" />
    </Button>
  );
}

export interface StatusIndicatorProps extends JSX.HTMLAttributes<HTMLSpanElement> {
  status: "ok" | "success" | "warn" | "warning" | "error" | "danger" | "info" | "offline" | "pending";
  label?: string;
  className?: string;
}

const statusClasses: Record<StatusIndicatorProps["status"], string> = {
  ok: "bg-[var(--status-success)]",
  success: "bg-[var(--status-success)]",
  warn: "bg-[var(--status-warning)]",
  warning: "bg-[var(--status-warning)]",
  error: "bg-[var(--status-danger)]",
  danger: "bg-[var(--status-danger)]",
  info: "bg-[var(--status-info)]",
  offline: "bg-[var(--text-tertiary)]",
  pending: "animate-pulse bg-[var(--status-warning)]",
};

/** A small status dot that is decorative unless a label is supplied. */
export function StatusIndicator(props: StatusIndicatorProps): JSX.Element {
  const [local, rest] = splitProps(props, ["status", "label", "className"]);
  return <span {...rest} class={cn("inline-block h-2 w-2 shrink-0 rounded-full", statusClasses[local.status], local.className)} role={local.label ? "img" : undefined} aria-label={local.label} aria-hidden={local.label === undefined ? "true" : undefined} />;
}
