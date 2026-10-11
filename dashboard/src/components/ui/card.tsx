import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

export type CardDensity = "default" | "compact";
export type CardSurface = "solid" | "glass" | "muted";
export type CardDepth = 1 | 2 | 3;
export type CardElevation = "none" | "card" | "popout";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Glass applies the translucent backdrop treatment (overrides `surface`). */
  glass?: boolean;
  /** `compact` reduces vertical padding for dense lists. */
  density?: CardDensity;
  /** Visual surface. `muted` uses a secondary background without elevation. */
  surface?: CardSurface;
  /** Adds the shared lift/border treatment for clickable cards. */
  interactive?: boolean;
  /** Overrides the global glass depth for this card (1 is subtle, 3 is strongest). */
  depth?: CardDepth;
  /** Controls the card shadow without requiring route-specific styles. */
  elevation?: CardElevation;
}

/*
 * The `card-*` tokens are kept as markers: the glass treatment keys off them
 * (`html[data-glass-enabled="true"] .card-solid`, `.card-glass`) and the
 * `[data-depth]` ladder sets `--card-glass-depth`, which drives a
 * `backdrop-filter: blur(calc(...))` that no utility can express because the
 * depth is a custom property multiplied inside `calc()`.
 */
const SURFACE: Record<CardSurface, string> = {
  solid: "card-solid bg-surface-1",
  glass: "card-glass bg-glass-bg",
  muted: "card-muted bg-surface-2",
};

const ELEVATION: Record<CardElevation, string> = {
  none: "card-elevation-none shadow-none",
  card: "card-elevation-card shadow-card",
  popout: "card-elevation-popout shadow-popout",
};

function surfaceClass({ glass = false, surface = "solid" }: CardProps): string {
  return glass ? SURFACE.glass : SURFACE[surface];
}

export function Card({
  className = "",
  glass,
  density,
  surface,
  interactive = false,
  depth,
  elevation,
  children,
  ...props
}: CardProps) {
  return (
    <div
      className={cn(
        "border border-inner-border rounded-card leading-normal",
        surfaceClass({ glass, surface }),
        "shadow-card",
        density === "compact" && "card-compact leading-[1.35]",
        interactive && "transition-[transform,border-color,box-shadow] duration-150 ease-spring hover:-translate-y-0.5 hover:shadow-card",
        elevation !== undefined && ELEVATION[elevation],
        className,
      )}
      data-depth={depth}
      {...props}
    >
      {children}
    </div>
  );
}

export interface CardHeaderProps {
  title: string;
  subtitle?: string;
  /** Compact controls or metadata kept alongside the subtitle. */
  subtitleAddon?: ReactNode;
  icon?: ReactNode;
  /**
   * Rendered before the icon and title, at the far left. For window-style
   * controls that should read as belonging to the whole card.
   */
  leading?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function CardHeader({
  title,
  subtitle,
  subtitleAddon,
  icon,
  leading,
  action,
  className = "",
}: CardHeaderProps): ReactNode {
  return (
    <div className={cn("card-header-bar", className)}>
      <div className="card-header-left">
        {leading ? <div className="card-header-leading">{leading}</div> : null}
        {icon ? <div className="card-header-icon">{icon}</div> : null}
        <div className="card-header-titles">
          <h2 className="card-header-title">{title}</h2>
          {subtitle || subtitleAddon ? (
            <div className="card-header-subtitle-row">
              {subtitle ? <p className="card-header-subtitle">{subtitle}</p> : null}
              {subtitleAddon}
            </div>
          ) : null}
        </div>
      </div>
      {action ? <div className="card-header-action">{action}</div> : null}
    </div>
  );
}

export function CardBody({ className = "", children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("card-body-content", className)} {...props}>
      {children}
    </div>
  );
}
