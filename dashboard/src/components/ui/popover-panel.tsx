import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/** Shared surface for floating controls. Base styling stays identical across desktop/mobile; callers only extend placement/width. */
export function PopoverPanel({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("z-50 max-h-[min(70vh,28rem)] overflow-y-auto rounded-2xl border border-[var(--inner-border)] bg-[var(--glass-bg-2)] p-3 text-[var(--text-1)] shadow-2xl backdrop-blur-[6px]", className)}>{children}</div>;
}
