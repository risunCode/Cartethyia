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
        "badge inline-flex items-center gap-[5px] rounded-[6px] px-[9px] py-[3px] text-[11px] font-semibold whitespace-nowrap",
        toneMap[tone],
        className,
      )}
      {...props}
    >
      {dot ? (
        <span
          className="status-indicator-dot"
          aria-hidden="true"
          style={{ background: "currentColor" }}
        />
      ) : null}
      {children}
    </span>
  );
}
