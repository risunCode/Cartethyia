
import { For, type JSX } from "solid-js";
import { Search } from "lucide-solid";
import { cn } from "../../lib/cn";

export type LogLevel = "all" | "debug" | "info" | "warn" | "error";

export interface LogFilterProps {
  level: LogLevel;
  onLevelChange: (next: LogLevel) => void;
  source?: string;
  onSourceChange?: (next: string) => void;
  className?: string;
}

const LEVEL_OPTIONS: ReadonlyArray<{ value: LogLevel; label: string; tone: string }> = [
  { value: "all", label: "All", tone: "text-[var(--text-2)]" },
  { value: "debug", label: "Debug", tone: "text-[var(--text-3)]" },
  { value: "info", label: "Info", tone: "text-[var(--accent)]" },
  { value: "warn", label: "Warn", tone: "text-[var(--status-warning)]" },
  { value: "error", label: "Error", tone: "text-[var(--status-danger)]" },
];

/**
 * Inline filter control for the console-log view: level chip group plus
 * optional source text filter. Keeps state bounded to the parent page so it
 * composes with both live (LogStream) and historical (LogHistory) sources.
 */
export function LogFilter(props: LogFilterProps): JSX.Element {
  return (
    <div
      role="toolbar"
      aria-label="Console log filters"
      class={cn(
        "flex flex-col items-stretch gap-3 rounded-[var(--radius-card)] border border-[var(--inner-border)] bg-[var(--surface-1)] p-2.5 shadow-[var(--shadow-card)] sm:flex-row sm:flex-wrap sm:items-center",
        props.className,
      )}
    >
      <div class="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Minimum log level">
        <span class="px-1 text-[10px] font-bold uppercase tracking-wider text-[var(--text-3)]">Level</span>
        <For each={LEVEL_OPTIONS}>
          {(option) => (
            <button
              type="button"
              role="radio"
              aria-checked={props.level === option.value}
              tabIndex={props.level === option.value ? 0 : -1}
              onClick={() => props.onLevelChange(option.value)}
              class={cn(
                "rounded-[var(--radius-control)] px-3 py-1.5 text-[10.5px] font-semibold transition-colors duration-150",
                props.level === option.value
                  ? "bg-[var(--accent)] text-white"
                  : cn("bg-[var(--hover)] hover:bg-[var(--active-pill)]", option.tone),
              )}
            >
              {option.label}
            </button>
          )}
        </For>
      </div>

      {props.onSourceChange && (
        <label class="relative flex min-w-0 flex-1 items-center gap-1.5 sm:flex-none">
          <span class="text-[10px] font-bold uppercase tracking-wider text-[var(--text-3)]">Source</span>
          <input
            type="text"
            value={props.source ?? ""}
            placeholder="any"
            onInput={(event) => props.onSourceChange?.(event.currentTarget.value)}
            class="h-8 min-w-0 flex-1 rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] pl-8 pr-2.5 text-[11px] text-[var(--text-1)] outline-none transition-colors duration-150 placeholder:text-[var(--text-3)] focus:border-[var(--accent)] sm:w-36 sm:flex-none"
          />
          <Search class="pointer-events-none absolute left-2.5 text-[var(--text-3)]" size={13} aria-hidden="true" />
        </label>
      )}
    </div>
  );
}
