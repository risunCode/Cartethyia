
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
        "relative h-5 w-9 shrink-0 rounded-full border transition-colors duration-200",
        disabledControlClasses,
        focusRingClasses,
        props.checked ? "border-transparent bg-[var(--accent)]" : "border-[var(--inner-border)] bg-[var(--track)]",
      )}
    >
      <span aria-hidden="true" class={cn("absolute left-0.5 top-0.5 block h-4 w-4 rounded-full bg-white shadow transition-transform duration-150", props.checked ? "translate-x-[18px]" : "translate-x-0")} />
    </button>
  );
}
