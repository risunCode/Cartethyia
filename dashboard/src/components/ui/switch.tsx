import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  label?: string;
  /** Accessible name override. Defaults to the visible `label` when present. */
  ["aria-label"]?: string;
  /** Merged onto the label, so a caller can position the control (e.g. `ml-3`). */
  className?: string;
}

export function Switch({
  checked,
  onChange,
  disabled = false,
  id,
  label,
  ["aria-label"]: ariaLabel,
  className = "",
}: SwitchProps): ReactNode {
  return (
    <label
      htmlFor={id}
      className={cn(`switch-container ${disabled ? "is-disabled" : ""}`.trim(), className)}
    >
      <button
        type="button"
        id={id}
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel ?? label}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={`switch-track ${checked ? "is-checked" : ""}`}
      >
        <span className="switch-thumb" />
      </button>
      {label ? <span className="switch-label">{label}</span> : null}
    </label>
  );
}
