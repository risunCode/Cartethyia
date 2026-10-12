import { Brain } from "lucide-react";
import type { ReactNode } from "react";
import type { LabEffort } from "./protocol";

const EFFORTS: readonly LabEffort[] = ["high", "max", "auto", "low", "medium"];

const EFFORT_LABELS: Readonly<Record<LabEffort, string>> = {
  auto: "Auto",
  low: "Low",
  medium: "Medium",
  high: "High",
  max: "Max",
};

/** A single button that cycles to the next Model Lab reasoning effort. */
export function EffortPicker({
  value,
  onChange,
  disabled = false,
}: {
  readonly value: LabEffort;
  readonly onChange: (value: LabEffort) => void;
  readonly disabled?: boolean;
}): ReactNode {
  const currentIndex = EFFORTS.indexOf(value);
  const nextEffort = EFFORTS[(currentIndex + 1) % EFFORTS.length] ?? "high";
  const label = EFFORT_LABELS[value];
  const nextLabel = EFFORT_LABELS[nextEffort];

  return (
    <button
      type="button"
      aria-label={`Reasoning effort: ${label}. Tap to change to ${nextLabel}.`}
      title={`Reasoning effort: ${label} · tap for ${nextLabel}`}
      disabled={disabled}
      onClick={() => onChange(nextEffort)}
      className="inline-flex items-center gap-3 h-15 px-5 border border-inner-border rounded-control bg-hover text-text-secondary text-caption font-semibold cursor-pointer transition-colors hover:border-border-strong hover:bg-active-pill hover:text-text-primary focus-visible:outline-2 focus-visible:outline-focus-ring focus-visible:outline-offset-1 disabled:opacity-60 disabled:cursor-not-allowed max-small:shrink-0"
    >
      <Brain size={14} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}
