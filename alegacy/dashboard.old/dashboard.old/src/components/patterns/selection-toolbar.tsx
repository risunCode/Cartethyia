import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";

export interface SelectionToolbarProps {
  selectedCount: number;
  totalCount: number;
  allSelected: boolean;
  onToggleAll: () => void;
  children?: ReactNode;
  className?: string;
}

/** Provides a consistent select-all summary and batch-action slot for lists. */
export function SelectionToolbar({ selectedCount, totalCount, allSelected, onToggleAll, children, className }: SelectionToolbarProps) {
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2", className)}>
      <div className="flex items-center gap-2 text-[11px] text-[var(--text-2)]">
        <Button variant="ghost" size="sm" className="h-7 px-2 text-[10px]" onClick={onToggleAll} aria-pressed={allSelected}>
          {allSelected ? "Clear all" : "Select all"}
        </Button>
        <span>{selectedCount > 0 ? `${selectedCount} selected` : `${totalCount} available`}</span>
      </div>
      {selectedCount > 0 && <div className="flex flex-wrap items-center gap-1.5">{children}</div>}
    </div>
  );
}
