import type { HTMLAttributes, TableHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export interface ActionGroupProps extends HTMLAttributes<HTMLDivElement> {
  align?: "start" | "end";
  density?: "compact" | "default";
}

export function ActionGroup({ align = "end", density = "default", className, ...props }: ActionGroupProps) {
  return <div className={cn("flex min-w-0 flex-wrap items-center", align === "end" ? "justify-end" : "justify-start", density === "compact" ? "gap-1.5" : "gap-2", className)} {...props} />;
}

export interface DataTableProps extends TableHTMLAttributes<HTMLTableElement> {
  minWidth?: number;
  label?: string;
}

export function DataTable({ minWidth = 640, label, className, ...props }: DataTableProps) {
  return (
    <div className="min-w-0 max-w-full overflow-x-auto overscroll-x-contain scrollbar-none" role={label ? "region" : undefined} aria-label={label} tabIndex={label ? 0 : undefined}>
      <table className={cn("w-full border-collapse text-left text-xs", className)} style={{ minWidth }} {...props} />
    </div>
  );
}
