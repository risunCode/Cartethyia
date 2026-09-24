import type { HTMLAttributes, ReactNode } from "react";

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

function surfaceClass({ glass = false, surface = "solid" }: CardProps): string {
  if (glass || surface === "glass") return "card-glass";
  if (surface === "muted") return "card-muted";
  return "card-solid";
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
  const classes = [
    surfaceClass({ glass, surface }),
    ...(density === "compact" ? ["card-compact"] : []),
    ...(interactive ? ["card-interactive"] : []),
    ...(elevation ? [`card-elevation-${elevation}`] : []),
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes} data-depth={depth} {...props}>
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
    <div className={`card-header-bar ${className}`.trim()}>
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
    <div className={`card-body-content ${className}`.trim()} {...props}>
      {children}
    </div>
  );
}
