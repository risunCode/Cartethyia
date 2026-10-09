import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface ToolbarProps {
  readonly children: ReactNode;
  readonly meta?: ReactNode;
  readonly className?: string;
}

/** Responsive filter/action strip shared by data-heavy dashboard pages. */
export function Toolbar({ children, meta, className = "" }: ToolbarProps): ReactNode {
  return (
    <div className={cn("flex items-center justify-between gap-[8px] flex-wrap", className)}>
      <div className="flex items-center gap-[8px] flex-wrap min-w-0">{children}</div>
      {meta ? (
        <div className="ml-auto text-text-tertiary text-[11px]">{meta}</div>
      ) : null}
    </div>
  );
}
