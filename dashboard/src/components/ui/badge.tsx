import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

type Tone = "default" | "ok" | "err" | "warn" | "info" | "accent";

const tones: Record<Tone, string> = {
  default: "bg-[var(--hover)] text-[var(--text-2)] border-[var(--inner-border)]",
  ok: "bg-[var(--green-soft)] text-[var(--green)] border-transparent",
  err: "bg-[var(--red-soft)] text-[var(--red)] border-transparent",
  warn: "bg-[var(--orange-soft)] text-[var(--orange)] border-transparent",
  info: "bg-[var(--teal-soft)] text-[var(--teal)] border-transparent",
  accent: "bg-[var(--accent-soft)] text-[var(--accent)] border-transparent",
};

export function Badge({
  tone = "default",
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10.5px] font-semibold",
        tones[tone],
        className
      )}
      {...props}
    />
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("skeleton h-4 w-full", className)} />;
}
