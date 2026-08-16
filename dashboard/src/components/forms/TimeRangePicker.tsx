
import type { JSX } from "solid-js";
import { Select } from "../ui/tabs";
import { cn } from "../../lib/cn";

export type TimeRange = "1h" | "24h" | "7d" | "30d" | "all";

export interface TimeRangeOption {
  value: TimeRange;
  label: string;
}

export interface TimeRangePickerProps {
  value: TimeRange;
  onChange: (value: TimeRange) => void;
  options?: readonly TimeRangeOption[];
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
}

const DEFAULT_OPTIONS: readonly TimeRangeOption[] = [
  { value: "1h", label: "1h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
];

const VALID_RANGES: Record<TimeRange, true> = {
  "1h": true,
  "24h": true,
  "7d": true,
  "30d": true,
  all: true,
};

/** Normalize arbitrary input to a known TimeRange. */
export function asTimeRange(value: string | undefined | null): TimeRange {
  if (value === null || value === undefined) return "24h";
  return VALID_RANGES[value as TimeRange] !== undefined ? (value as TimeRange) : "24h";
}

/**
 * TimeRangePicker — thin wrapper over solidcn-ui Select that constrains
 * the value to known periods. The picker is keyboard-navigable and exposes
 * an aria-label for assistive tech.
 */
export function TimeRangePicker(props: TimeRangePickerProps): JSX.Element {
  const options = (): readonly TimeRangeOption[] => props.options ?? DEFAULT_OPTIONS;
  return (
    <Select
      ariaLabel={props.ariaLabel ?? "Time range"}
      value={props.value}
      options={options()}
      onChange={(value) => props.onChange(asTimeRange(value))}
      className={cn("min-w-[80px]", props.className)}
    />
  );
}
