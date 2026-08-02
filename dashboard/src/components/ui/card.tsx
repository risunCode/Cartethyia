import type { HTMLAttributes, ComponentType } from "react";
import { cn } from "../../lib/cn";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("glass overflow-hidden rounded-[var(--radius-card)] p-[18px]", className)} {...props} />;
}

export function CardHeader({
  title,
  sub,
  icon: Icon,
  iconColor,
  children,
}: {
  title: string;
  sub?: string;
  /** Optional leading icon — rendered in a small tinted circle ahead of the title. */
  icon?: ComponentType<{ size?: number }>;
  /** Icon + circle tint; defaults to the accent color. */
  iconColor?: string;
  children?: React.ReactNode;
}) {
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
            <Icon size={15} />
          </span>
        )}
        <div className="min-w-0">
          <div className="truncate text-sm font-bold">{title}</div>
          {sub && <div className="mt-0.5 truncate text-[11.5px] text-[var(--text-2)]">{sub}</div>}
        </div>
      </div>
      {children && <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto">{children}</div>}
    </div>
  );
}
