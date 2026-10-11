import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export type BadgeTone =
  | "default"
  | "ok"
  | "err"
  | "warn"
  | "info"
  | "accent"
  | "active"
  | "cooldown"
  | "disabled"
  | "purple"
  | "teal"
  | "green"
  | "blue"
  | "orange";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  dot?: boolean;
}

/*
 * Marker class + utilities. `primitives.test.tsx` and the few descendant rules
 * that survived in the sheets select on `.badge`, so the token stays; the tone
 * is a utility pair.
 */
const toneMap: Record<BadgeTone, string> = {
  default: "badge-default bg-hover text-text-secondary border border-inner-border",
  ok: "badge-ok bg-green-soft text-green",
  active: "badge-active bg-green-soft text-green",
  err: "badge-err bg-red-soft text-red",
  disabled: "badge-disabled bg-red-soft text-red",
  warn: "badge-warn bg-orange-soft text-orange",
  cooldown: "badge-warn bg-orange-soft text-orange",
  info: "badge-info bg-teal-soft text-teal",
  accent: "badge-accent bg-accent-soft text-accent",
  purple: "badge-accent bg-accent-soft text-accent",
  teal: "badge-info bg-teal-soft text-teal",
  green: "badge-ok bg-green-soft text-green",
  blue: "badge-info bg-status-info-soft text-status-info",
  orange: "badge-warn bg-orange-soft text-orange",
};

export function Badge({
  tone = "default",
  dot = false,
  className = "",
  children,
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        "badge inline-flex items-center gap-2.5 rounded-chip px-4.5 py-1.5 text-xs font-semibold whitespace-nowrap",
        toneMap[tone],
        className,
      )}
      {...props}
    >
      {dot ? (
        // `bg-current` carries the inherited text colour, which is what the inline
        // `background: "currentColor"` used to do — the dot follows the badge's
        // tone instead of the fixed dot-state colours in the sheet.
        <span className="status-indicator-dot bg-current" aria-hidden="true" />
      ) : null}
      {children}
    </span>
  );
}
