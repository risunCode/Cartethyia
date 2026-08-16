
import type { JSX } from "solid-js";
import { Show } from "solid-js";
import type { LucideIcon } from "lucide-solid";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-solid";
import { Badge, type BadgeTone } from "../ui/badge";
import { StatusIndicator, type StatusIndicatorProps } from "../ui/icon";
import { cn } from "../../lib/cn";

export type StatusBadgeStatus = "active" | "healthy" | "degraded" | "warning" | "down" | "error" | "offline" | "pending";

export interface StatusBadgeProps {
  status: StatusBadgeStatus;
  /** Short human label rendered inside the badge. Defaults to status. */
  label?: string;
  /** Optional leading icon. Replaces the default status dot when provided. */
  icon?: LucideIcon;
  /** Override the badge tone; default tone is derived from status. */
  tone?: BadgeTone;
  /** Render an inline dot indicator alongside the label. Defaults to true. */
  showDot?: boolean;
  /** Optional sub-label shown to the right of the main badge. */
  detail?: string;
  /** Animation: when true the indicator pulses (useful for "pending"). */
  pulse?: boolean;
  className?: string;
}

interface StatusStyle {
  tone: BadgeTone;
  indicator: StatusIndicatorProps["status"];
  defaultLabel: string;
  icon?: LucideIcon;
}

const statusStyles: Record<StatusBadgeStatus, StatusStyle> = {
  active: { tone: "success", indicator: "ok", defaultLabel: "Active" },
  healthy: { tone: "success", indicator: "ok", defaultLabel: "Healthy" },
  degraded: { tone: "warning", indicator: "warn", defaultLabel: "Degraded", icon: AlertTriangle },
  warning: { tone: "warning", indicator: "warn", defaultLabel: "Warning", icon: AlertTriangle },
  down: { tone: "danger", indicator: "error", defaultLabel: "Down", icon: XCircle },
  error: { tone: "danger", indicator: "error", defaultLabel: "Error", icon: XCircle },
  offline: { tone: "neutral", indicator: "offline", defaultLabel: "Offline" },
  pending: { tone: "info", indicator: "pending", defaultLabel: "Pending" },
};

/**
 * StatusBadge — a semantic badge with a leading status dot.
 *
 * Status semantics are encoded once in `statusStyles` so that callers
 * never have to pair a tone with a dot color. Plays a 200ms fade-in
 * entrance animation on first mount.
 */
export function StatusBadge(props: StatusBadgeProps): JSX.Element {
  const style = (): StatusStyle => statusStyles[props.status];
  const tone = (): BadgeTone => props.tone ?? style().tone;
  const text = (): string => props.label ?? style().defaultLabel;
  const indicator = (): StatusIndicatorProps["status"] => {
    if (props.pulse && props.status !== "offline") return "pending";
    return style().indicator;
  };
  const FallbackIcon = (): LucideIcon | undefined => style().icon;

  return (
    <span
      class={cn("component-fade-in inline-flex items-center gap-1.5", props.className)}
      role="status"
      aria-live="polite"
    >
      <Badge tone={tone()}>
        <span class="inline-flex items-center gap-1">
          <Show when={props.showDot !== false}>
            <StatusIndicator status={indicator()} aria-hidden="true" />
          </Show>
          <Show when={props.icon}>
            {(icon) => {
              const Icon = icon();
              return <Icon size={11} aria-hidden="true" />;
            }}
          </Show>
          <Show when={!props.icon && FallbackIcon()}>
            {(icon) => {
              const Icon = icon();
              return <Icon size={11} aria-hidden="true" />;
            }}
          </Show>
          <span class="truncate">{text()}</span>
        </span>
      </Badge>
      <Show when={props.detail}>
        {(detail) => <span class="truncate text-[10px] text-[var(--text-3)]">{detail()}</span>}
      </Show>
    </span>
  );
}

/**
 * Helper that maps a Cartethyia health enum (string) into a StatusBadgeStatus.
 * Centralized so callers don't re-implement the mapping.
 */
export function mapHealthToStatus(health: "active" | "degraded" | "down" | string | null | undefined): StatusBadgeStatus {
  if (!health) return "offline";
  const value = health.toLowerCase();
  if (value === "active" || value === "healthy" || value === "ok" || value === "up") return "active";
  if (value === "degraded" || value === "warn" || value === "warning" || value === "slow") return "degraded";
  if (value === "down" || value === "offline" || value === "error" || value === "failed" || value === "down") return "down";
  if (value === "pending" || value === "starting") return "pending";
  return "offline";
}

export const StatusBadgeHealthIcons = { CheckCircle2, AlertTriangle, XCircle } as const;
