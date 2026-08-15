/* @jsxImportSource solid-js */

import { splitProps, type JSX } from "solid-js";
import type { LucideIcon } from "lucide-solid";
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
  frame: "border border-[var(--glass-border)] bg-[var(--surface-1)] shadow-[var(--shadow-card)]",
};

export interface CardProps extends JSX.HTMLAttributes<HTMLDivElement> {
  density?: CardDensity;
  surface?: CardSurface;
  className?: string;
}

/** A themed surface with consistent density and elevation options. */
export function Card(props: CardProps): JSX.Element {
  const [local, rest] = splitProps(props, ["className", "density", "surface"]);
  return <div {...rest} class={cn("overflow-hidden rounded-[var(--radius-card)]", surfaceClasses[local.surface ?? "base"], densityClasses[local.density ?? "default"], local.className)} />;
}

export interface CardHeaderProps {
  title: string;
  sub?: string;
  icon?: LucideIcon;
  iconColor?: string;
  children?: JSX.Element;
}

/** A wrapping card header that keeps actions visible on narrow screens. */
export function CardHeader(props: CardHeaderProps): JSX.Element {
  const Icon = props.icon;
  const iconColor = () => props.iconColor ?? "var(--accent)";
  return (
    <div class="mb-4 flex flex-wrap items-start justify-between gap-2.5">
      <div class="flex w-full min-w-0 flex-1 items-start gap-2.5 sm:w-auto">
        {Icon && (
          <span
            class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
            style={{ "background-color": `color-mix(in srgb, ${iconColor()} 15%, transparent)`, color: iconColor() }}
          >
            <Icon size={15} aria-hidden="true" />
          </span>
        )}
        <div class="min-w-0">
          <div class="truncate text-sm font-bold">{props.title}</div>
          {props.sub && <div class="mt-0.5 truncate text-[11.5px] text-[var(--text-2)]">{props.sub}</div>}
        </div>
      </div>
      {props.children && <div class="ml-auto flex w-full flex-wrap items-center justify-end gap-1.5 sm:w-auto">{props.children}</div>}
    </div>
  );
}
