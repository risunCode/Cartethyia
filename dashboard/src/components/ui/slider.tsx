import { forwardRef, type ReactNode } from "react";

export interface SliderProps {
  readonly label?: string;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly value: number;
  readonly onValueChange: (value: number) => void;
  readonly disabled?: boolean;
  readonly id?: string;
}

/** Native styled range primitive used by dashboard forms. */
export const Slider = forwardRef<HTMLInputElement, SliderProps>(function Slider(
  { label, min, max, step = 1, value, onValueChange, disabled, id },
  ref,
): ReactNode {
  return (
    <div className="form-group">
      {label ? (
        <label className="form-label" htmlFor={id}>
          <span>{label}</span>
          <span className="form-hint">{value}</span>
        </label>
      ) : null}
      <input
        ref={ref}
        id={id}
        type="range"
        className="form-range radix-slider-root"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onValueChange(Number(e.target.value))}
        style={{ width: "100%" }}
      />
    </div>
  );
});
