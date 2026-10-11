import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

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
      className={cn(
        "list-row flex items-center gap-6 rounded-control border border-inner-border bg-surface-2 min-w-0 px-7 py-5",
        density === "compact" && "list-row-compact px-5 py-3 rounded-inset gap-4",
        className,
      )}
      {...props}
    >
      {leading ? <div className="list-row-leading shrink-0">{leading}</div> : null}
      <div className="list-row-body flex-1 min-w-0 flex flex-col gap-2">{children}</div>
      {actions ? (
        <div className="list-row-actions flex items-center gap-2 shrink-0 flex-wrap">
          {actions}
        </div>
      ) : null}
    </div>
  );
}
