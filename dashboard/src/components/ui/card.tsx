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
    <div className="mb-4 flex items-start justify-between gap-2.5">
      <div className="flex items-start gap-2.5">
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
      {children}
    </div>
  );
}
