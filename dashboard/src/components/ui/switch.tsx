export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  label?: string;
  /** Accessible name override. Defaults to the visible `label` when present. */
  ["aria-label"]?: string;
}

export function Switch({
  checked,
  onChange,
  disabled = false,
  id,
  label,
  ["aria-label"]: ariaLabel,
}: SwitchProps) {
  return (
    <label htmlFor={id} className={`switch-container ${disabled ? "is-disabled" : ""}`.trim()}>
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
