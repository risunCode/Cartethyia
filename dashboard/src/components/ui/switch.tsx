
import { cn } from "../../lib/cn";
import { disabledControlClasses, focusRingClasses } from "./styles";

export interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label?: string;
}

/** A native button switch with an explicit checked state and accessible name. */
export function Switch(props: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
      class={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors duration-200",
        disabledControlClasses,
        focusRingClasses,
        props.checked
          ? "border-transparent bg-[var(--accent)] shadow-[0_2px_8px_rgba(0,0,0,0.12)]"
          : "border-[var(--border-strong)] bg-[var(--kbd-bg)] hover:bg-[var(--surface-hover)]",
      )}
    >
      <span
        aria-hidden="true"
        class={cn(
          "block h-5 w-5 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.25)] transition-transform duration-200",
          props.checked ? "translate-x-[22px]" : "translate-x-[2px]",
        )}
      />
    </button>
  );
}
