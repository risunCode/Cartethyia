
import { Show, type JSX } from "solid-js";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";

export interface SelectionToolbarProps {
  selectedCount: number;
  totalCount: number;
  allSelected: boolean;
  onToggleAll: () => void;
  children?: JSX.Element;
  className?: string;
}

/** Provides a consistent select-all summary and batch-action slot for lists. */
export function SelectionToolbar(props: SelectionToolbarProps): JSX.Element {
  return (
    <div class={cn("flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2", props.className)}>
      <div class="flex items-center gap-2 text-[11px] text-[var(--text-2)]">
        <Button variant="ghost" size="sm" class="h-7 px-2 text-[10px]" onClick={props.onToggleAll} aria-pressed={props.allSelected}>
          {props.allSelected ? "Clear all" : "Select all"}
        </Button>
        <span>{props.selectedCount > 0 ? `${props.selectedCount} selected` : `${props.totalCount} available`}</span>
      </div>
      <Show when={props.selectedCount > 0}>
        <div class="flex flex-wrap items-center gap-1.5">{props.children}</div>
      </Show>
    </div>
  );
}
