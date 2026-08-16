
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import type { LucideIcon } from "lucide-solid";
import { Check, ChevronDown } from "lucide-solid";
import { Dropdown as DropdownPrimitive } from "../ui/dropdown";
import { cn } from "../../lib/cn";
import { focusRingClasses } from "../ui/styles";

export interface DropdownOption {
  value: string;
  label: string;
  description?: string;
  icon?: LucideIcon;
  disabled?: boolean;
}

export interface DropdownProps {
  /** Controlled value. */
  value: string;
  /** Fired when the user picks an option. */
  onChange: (value: string) => void;
  /** Selectable options. */
  options: readonly DropdownOption[];
  /** Visible label for the closed trigger button. */
  placeholder?: string;
  /** Accessible label for the trigger button (used when no visible label). */
  ariaLabel?: string;
  /** Place the menu flush to the start or end of the trigger. */
  align?: "start" | "end";
  /** Disable the entire control. */
  disabled?: boolean;
  /** Mark as required for assistive tech. */
  required?: boolean;
  /** Render an inline label above the trigger. */
  label?: string;
  /** Optional id; defaults to a generated string. */
  id?: string;
  /** Optional className for the trigger wrapper. */
  className?: string;
  /** Optional className for the menu panel. */
  panelClassName?: string;
  /** Fires after the close transition completes. */
  onExited?: () => void;
}

let uidCounter = 0;
const nextDropdownId = (): string => `forms-dropdown-${++uidCounter}`;

/**
 * Dropdown — a form-friendly select built on the shared `Dropdown` primitive.
 *
 * Combobox semantics (role=combobox, aria-expanded, listbox children) expose
 * the trigger as a single-tabstop control while preserving keyboard Enter /
 * Space selection inside the panel. Uses the shared `popout-enter`
 * animation (~180ms slide+fade) and a 200ms fade-in on the wrapper.
 */
export function Dropdown(props: DropdownProps): JSX.Element {
  const generatedId = createMemo(() => props.id ?? nextDropdownId());
  const [open, setOpen] = createSignal(false);

  const selected = (): DropdownOption | undefined =>
    props.options.find((option) => option.value === props.value);

  const triggerLabel = (): string => selected()?.label ?? props.placeholder ?? "Select…";
  const isPlaceholder = (): boolean => selected() === undefined;

  const close = (): void => {
    setOpen(false);
  };

  const handleOptionKey = (event: KeyboardEvent, option: DropdownOption): void => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (option.disabled) return;
      props.onChange(option.value);
      close();
    }
  };

  return (
    <div class={cn("component-fade-in flex flex-col", props.className)}>
      <Show when={props.label}>
        {(label) => (
          <label
            for={generatedId()}
            class="mb-1.5 block text-xs font-semibold text-[var(--text-2)]"
          >
            {label()}
            <Show when={props.required}>
              <span class="ml-0.5 text-[var(--status-danger)]" aria-hidden="true">*</span>
            </Show>
          </label>
        )}
      </Show>
      <DropdownPrimitive
        open={open()}
        onClose={close}
        onOpenChange={setOpen}
        onExited={props.onExited}
        align={props.align ?? "start"}
        id={generatedId()}
        ariaLabel={props.ariaLabel ?? props.label ?? triggerLabel()}
        className={props.panelClassName}
        trigger={(triggerProps) => {
          const SelectedIcon = selected()?.icon;
          return (
            <button
              type="button"
              ref={(element) => triggerProps.ref(element as HTMLElement)}
              id={generatedId()}
              role="combobox"
              aria-haspopup="listbox"
              aria-expanded={triggerProps["aria-expanded"]}
              aria-controls={triggerProps["aria-controls"]}
              aria-label={props.ariaLabel ?? props.label}
              aria-required={props.required ? "true" : undefined}
              disabled={props.disabled}
              onClick={triggerProps.onClick}
              class={cn(
                "inline-flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] px-3 text-sm font-medium text-[var(--text-1)] outline-none transition-colors duration-150",
                "hover:bg-[var(--active-pill)] focus-visible:border-[var(--accent)] focus-visible:bg-[var(--glass-bg-2)]",
                focusRingClasses,
                "disabled:cursor-not-allowed disabled:opacity-50",
                isPlaceholder() && "text-[var(--text-3)]",
              )}
            >
              <span class="flex min-w-0 items-center gap-2">
                <Show when={SelectedIcon}>
                  {(icon) => {
                    const Icon = icon();
                    return <Icon size={14} aria-hidden="true" />;
                  }}
                </Show>
                <span class="truncate">{triggerLabel()}</span>
              </span>
              <ChevronDown
                size={14}
                class={cn("shrink-0 text-[var(--text-3)] transition-transform duration-150", open() && "rotate-180")}
                aria-hidden="true"
              />
            </button>
          );
        }}
      >
        <div role="listbox" aria-labelledby={generatedId()} class="p-1">
          <For each={props.options}>
            {(option) => {
              const isSelected = (): boolean => option.value === props.value;
              const Icon = option.icon;
              return (
                <div
                  role="option"
                  aria-selected={isSelected()}
                  aria-disabled={option.disabled ? "true" : undefined}
                  tabIndex={option.disabled ? -1 : 0}
                  onClick={() => {
                    if (option.disabled) return;
                    props.onChange(option.value);
                    close();
                  }}
                  onKeyDown={(event) => handleOptionKey(event, option)}
                  class={cn(
                    "flex w-full cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-medium text-[var(--text-1)] transition-colors duration-150 outline-none",
                    "hover:bg-[var(--hover)] focus-visible:bg-[var(--hover)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--focus-ring)]",
                    isSelected() && "bg-[var(--accent-soft)] text-[var(--accent)]",
                    option.disabled && "cursor-not-allowed opacity-50",
                  )}
                >
                  <Show when={Icon}>
                    {(icon) => {
                      const Component = icon();
                      return <Component size={14} class="mt-0.5 shrink-0" aria-hidden="true" />;
                    }}
                  </Show>
                  <span class="min-w-0 flex-1">
                    <span class="block truncate">{option.label}</span>
                    <Show when={option.description}>
                      {(description) => <span class="mt-0.5 block truncate text-[10px] font-normal text-[var(--text-3)]">{description()}</span>}
                    </Show>
                  </span>
                  <Show when={isSelected()}>
                    <Check size={14} class="mt-0.5 shrink-0" aria-hidden="true" />
                  </Show>
                </div>
              );
            }}
          </For>
          <Show when={props.options.length === 0}>
            <div class="px-2.5 py-3 text-center text-xs text-[var(--text-3)]">No options available</div>
          </Show>
        </div>
      </DropdownPrimitive>
    </div>
  );
}
