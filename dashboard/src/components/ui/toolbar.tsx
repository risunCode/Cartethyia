import type { ReactNode } from "react";
import { cn } from "../../lib/classnames";

export interface ToolbarProps {
  readonly children: ReactNode;
  readonly meta?: ReactNode;
  readonly className?: string;
}

/** Responsive filter/action strip shared by data-heavy dashboard pages. */
export function Toolbar({ children, meta, className = "" }: ToolbarProps): ReactNode {
  return (
    <div className={cn("flex items-center justify-between gap-4 flex-wrap", className)}>
      <div className="flex items-center gap-4 flex-wrap min-w-0">{children}</div>
      {meta ? (
        <div className="ml-auto text-text-tertiary text-badge">{meta}</div>
      ) : null}
    </div>
  );
}
