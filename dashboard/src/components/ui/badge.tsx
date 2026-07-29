import type { HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

type Tone = "default" | "ok" | "err" | "warn" | "info" | "accent";

const tones: Record<Tone, string> = {
  default: "bg-[var(--hover)] text-[var(--text-2)] border-[var(--inner-border)]",
  ok: "bg-[rgba(48,209,88,0.14)] text-[#1fa84a] dark:text-[var(--green)] border-transparent",
  err: "bg-[rgba(255,69,58,0.13)] text-[var(--red)] border-transparent",
  warn: "bg-[rgba(255,159,10,0.14)] text-[var(--orange)] border-transparent",
  info: "bg-[rgba(100,210,255,0.15)] text-[#0fa3d1] dark:text-[var(--teal)] border-transparent",
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
