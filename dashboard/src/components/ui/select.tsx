import * as RadixSelect from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { type CSSProperties, type ReactNode, useState } from "react";

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SelectProps {
  readonly value: string;
  readonly onValueChange?: (value: string) => void;
  readonly options: readonly SelectOption[];
  readonly placeholder?: string;
  readonly label?: string;
  readonly "aria-label"?: string;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly style?: CSSProperties;
  readonly className?: string;
  readonly size?: "sm" | "md" | "lg";
  readonly error?: string;
}

const SIZE_HEIGHT: Record<NonNullable<SelectProps["size"]>, number> = {
  sm: 30,
  md: 36,
  lg: 44,
};

export function Select({
  value,
  onValueChange,
  options,
  placeholder = "Select…",
  label,
  "aria-label": ariaLabelProp,
  disabled,
  id,
  style,
  className = "",
  size = "md",
  error,
}: SelectProps): ReactNode {
  const handler = onValueChange ?? (() => {});
  const selectedLabel = options.find((option) => option.value === value)?.label;
  const [open, setOpen] = useState(false);

  const trigger = (
    <RadixSelect.Root
      value={value}
      onValueChange={handler}
      disabled={disabled}
      open={open}
      onOpenChange={setOpen}
    >
      <RadixSelect.Trigger
        id={id}
        aria-label={ariaLabelProp ?? label}
        className={`radix-select-trigger ${className}`.trim()}
        style={{
          ...style,
          height: style?.height ?? `${SIZE_HEIGHT[size]}px`,
          opacity: disabled ? 0.6 : 1,
          cursor: disabled ? "not-allowed" : "pointer",
        }}
        data-state={open ? "open" : "closed"}
      >
        <RadixSelect.Value placeholder={placeholder}>
          {selectedLabel ?? placeholder}
        </RadixSelect.Value>
        <RadixSelect.Icon asChild>
          <ChevronDown size={14} />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>

      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={4}
          className="radix-select-content"
        >
          <RadixSelect.Viewport>
            {options.map((option) => (
              <RadixSelect.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className="radix-select-item"
              >
                <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                <RadixSelect.ItemIndicator className="radix-select-indicator">
                  <Check size={14} />
                </RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );

  if (!label) return trigger;

  return (
    <div className="form-group" style={style}>
      <label className="form-label" htmlFor={id}>
        {label}
      </label>
      {trigger}
      {error ? (
        <span style={{ fontSize: "11px", color: "var(--status-danger)" }}>{error}</span>
      ) : null}
    </div>
  );
}
