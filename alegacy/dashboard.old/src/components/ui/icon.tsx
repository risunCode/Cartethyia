import type { ButtonHTMLAttributes, HTMLAttributes } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/cn";
import type { ButtonVariant } from "./button";
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

export interface IconBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  icon: LucideIcon;
  tone?: IconTone;
  size?: IconSize;
  label?: string;
}

export function IconBadge({ icon: Icon, tone = "accent", size = "md", label, className, ...props }: IconBadgeProps) {
  return (
    <span className={cn("inline-flex shrink-0 items-center justify-center rounded-full", badgeSizes[size], toneClasses[tone], className)} aria-label={label} {...props}>
      <Icon aria-hidden={label === undefined} />
    </span>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children"> {
  icon: LucideIcon;
  label: string;
  size?: "sm" | "md" | "icon";
  variant?: ButtonVariant;
}

export function IconButton({ icon: Icon, label, size = "icon", variant = "ghost", ...props }: IconButtonProps) {
  return (
    <Button type="button" aria-label={label} size={size} variant={variant} {...props}>
      <Icon aria-hidden="true" />
    </Button>
  );
}

export interface StatusIndicatorProps extends HTMLAttributes<HTMLSpanElement> {
  status: "ok" | "success" | "warn" | "warning" | "error" | "danger" | "info" | "offline" | "pending";
  label?: string;
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

export function StatusIndicator({ status, label, className, ...props }: StatusIndicatorProps) {
  return <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full", statusClasses[status], className)} role={label ? "img" : undefined} aria-label={label} aria-hidden={label === undefined} {...props} />;
}
