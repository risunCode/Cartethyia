import { motion } from "framer-motion";
import { cn } from "../../lib/cn";

export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-6 w-10.5 shrink-0 rounded-full border transition-colors duration-200 disabled:opacity-40",
        checked ? "border-transparent bg-[var(--accent)]" : "border-[var(--inner-border)] bg-[var(--track)]"
      )}
    >
      <motion.span
        layout
        transition={{ type: "spring", stiffness: 600, damping: 34 }}
        className={cn(
          "absolute top-0.5 block h-4.5 w-4.5 rounded-full bg-white shadow",
          checked ? "left-5.5" : "left-0.5"
        )}
      />
    </button>
  );
}
