import type { HTMLAttributes, ReactNode } from "react";

export interface ListRowProps extends HTMLAttributes<HTMLDivElement> {
  readonly children?: ReactNode;
  /** Leading content that must not shrink, e.g. a drag rail or icon. */
  readonly leading?: ReactNode;
  /** Trailing actions; kept on one line and never stretched. */
  readonly actions?: ReactNode;
  /** Tighter padding for dense lists (combo member chips, header pairs). */
  readonly density?: "default" | "compact";
}

/**
 * One row of a managed list — an API credential, an alias, a combo, an
 * account. Owns the shared row card: surface, border, radius, and padding
 * that pages had been re-declaring inline per list.
 *
 * Content is laid out as `[leading?] [body] [actions?]`; the body fills and
 * can wrap freely.
 */
export function ListRow({
  children,
  leading,
  actions,
  density = "default",
  className = "",
  ...props
}: ListRowProps): ReactNode {
  return (
    <div
      className={`list-row${density === "compact" ? " list-row-compact" : ""} ${className}`.trim()}
      {...props}
    >
      {leading ? <div className="list-row-leading">{leading}</div> : null}
      <div className="list-row-body">{children}</div>
      {actions ? <div className="list-row-actions">{actions}</div> : null}
    </div>
  );
}
