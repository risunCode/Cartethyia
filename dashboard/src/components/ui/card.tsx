import type { ComponentType, HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

export type CardDensity = "compact" | "default" | "comfortable";
export type CardSurface = "base" | "muted" | "elevated" | "frame";

const densityClasses: Record<CardDensity, string> = {
  compact: "p-3",
  default: "p-4",
  comfortable: "p-5",
};

const surfaceClasses: Record<CardSurface, string> = {
  base: "glass",
  muted: "glass bg-[var(--surface-muted)]",
  elevated: "glass-2",
  /** Structural frame for grouping cards without adding a second blur layer. */
  frame: "border border-[var(--glass-border)] bg-[var(--surface-1)] shadow-[var(--shadow-card)]",
};

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  density?: CardDensity;
  surface?: CardSurface;
}

export function Card({ className, density = "default", surface = "base", ...props }: CardProps) {
  return <div className={cn("overflow-hidden rounded-[var(--radius-card)]", surfaceClasses[surface], densityClasses[density], className)} {...props} />;
}

export interface CardHeaderProps {
  title: string;
  sub?: string;
  /** Optional leading icon — rendered in a small tinted circle ahead of the title. */
  icon?: ComponentType<{ size?: number; strokeWidth?: number; className?: string; "aria-hidden"?: boolean }>;
  /** Icon + circle tint; defaults to the accent color. */
  iconColor?: string;
  children?: ReactNode;
}

export function CardHeader({
  title,
  sub,
  icon: Icon,
  iconColor,
  children,
}: CardHeaderProps) {
  return (
    // `flex-wrap` (not just `justify-between`) matters here: `Card` clips
    // overflow, and a long `sub` sentence next to action buttons (Edit/
    // Delete/Fetch, etc.) on a narrow viewport used to squeeze the button
    // cluster past its min-content width instead of ever wrapping \u2014 the
    // buttons rendered outside the card's width and were invisible, clipped
    // by `overflow-hidden`, not just visually cramped.
    <div className="mb-4 flex flex-wrap items-start justify-between gap-2.5">
      <div className="flex w-full min-w-0 flex-1 items-start gap-2.5 sm:w-auto">
        {Icon && (
          <span
            className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
            style={{ backgroundColor: `color-mix(in srgb, ${iconColor ?? "var(--accent)"} 15%, transparent)`, color: iconColor ?? "var(--accent)" }}
          >
            <Icon size={15} aria-hidden={true} />
          </span>
        )}
        <div className="min-w-0">
          <div className="truncate text-sm font-bold">{title}</div>
          {sub && <div className="mt-0.5 truncate text-[11.5px] text-[var(--text-2)]">{sub}</div>}
        </div>
      </div>
      {children && <div className="ml-auto flex w-full flex-wrap items-center justify-end gap-1.5 sm:w-auto">{children}</div>}
    </div>
  );
}
