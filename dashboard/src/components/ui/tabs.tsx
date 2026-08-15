/* @jsxImportSource solid-js */

import { cn } from "../../lib/cn";

export interface TabItem {
  id: string;
  label: string;
}

export interface TabsProps {
  tabs: TabItem[];
  value: string;
  onChange: (id: string) => void;
  panelId?: string;
  ariaLabel?: string;
}

/** A roving-tabindex tab list with keyboard arrow navigation. */
export function Tabs(props: TabsProps) {
  const move = (index: number, direction: number) => {
    const nextIndex = (index + direction + props.tabs.length) % props.tabs.length;
    props.onChange(props.tabs[nextIndex].id);
    document.getElementById(`${props.tabs[nextIndex].id}-tab`)?.focus();
  };

  return (
    <div class="flex flex-wrap gap-1.5" role="tablist" aria-label={props.ariaLabel}>
      {props.tabs.map((tab, index) => (
        <button
          type="button"
          id={`${tab.id}-tab`}
          role="tab"
          aria-selected={props.value === tab.id}
          aria-controls={props.panelId}
          tabIndex={props.value === tab.id ? 0 : -1}
          onClick={() => props.onChange(tab.id)}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowDown") {
              event.preventDefault();
              move(index, 1);
            } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
              event.preventDefault();
              move(index, -1);
            } else if (event.key === "Home") {
              event.preventDefault();
              move(index, -index);
            } else if (event.key === "End") {
              event.preventDefault();
              move(index, props.tabs.length - index - 1);
            }
          }}
          class={cn(
            "rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-[color,background-color,border-color,transform] duration-150 active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]",
            props.value === tab.id
              ? "border-transparent bg-[var(--accent-soft)] text-[var(--accent)]"
              : "border-[var(--inner-border)] bg-[var(--hover)] text-[var(--text-2)] hover:bg-[var(--active-pill)] hover:text-[var(--text-1)]",
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  ariaLabel?: string;
  className?: string;
}

/** A themed native select for compact option lists. */
export function Select(props: SelectProps) {
  return (
    <select
      aria-label={props.ariaLabel}
      value={props.value}
      onChange={(event) => props.onChange(event.currentTarget.value)}
      class={cn(
        "h-8 rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] px-2 text-xs font-medium text-[var(--text-1)] outline-none transition-colors focus:border-[var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]",
        props.className,
      )}
    >
      {props.options.map((option) => <option value={option.value}>{option.label}</option>)}
    </select>
  );
}
