import type { HTMLAttributes } from "react";

export type BadgeTone =
  | "default"
  | "ok"
  | "err"
  | "warn"
  | "info"
  | "accent"
  | "active"
  | "degraded"
  | "cooldown"
  | "disabled"
  | "purple"
  | "teal"
  | "green"
  | "orange";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  dot?: boolean;
}

const toneMap: Record<BadgeTone, string> = {
  default: "badge-default",
  ok: "badge-ok",
  active: "badge-active",
  err: "badge-err",
  disabled: "badge-disabled",
  warn: "badge-warn",
  degraded: "badge-degraded",
  cooldown: "badge-warn",
  info: "badge-info",
  accent: "badge-accent",
  purple: "badge-accent",
  teal: "badge-info",
  green: "badge-ok",
  orange: "badge-warn",
};

export function Badge({
  tone = "default",
  dot = false,
  className = "",
  children,
  ...props
}: BadgeProps) {
  const toneClass = toneMap[tone] ?? "badge-default";
  return (
    <span className={`badge ${toneClass} ${className}`.trim()} {...props}>
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
