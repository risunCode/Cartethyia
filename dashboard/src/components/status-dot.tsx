/* @jsxImportSource solid-js */

import { cn } from "../lib/cn";

export function StatusDot(props: { status: "ok" | "warn" | "off"; className?: string }) {
  const color = props.status === "ok" ? "bg-[var(--green)] shadow-[0_0_0_3px_rgba(48,209,88,0.18)]" : props.status === "warn" ? "bg-[var(--orange)] shadow-[0_0_0_3px_rgba(255,159,10,0.18)]" : "bg-[var(--text-3)]";
  return <span class={cn("inline-block h-2 w-2 rounded-full", color, props.className)} />;
}
