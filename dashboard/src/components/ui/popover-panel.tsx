import type { JSX } from "solid-js";
import { cn } from "../../lib/cn";
import { floatingSurfaceClasses } from "./styles";

/** Shared surface for floating controls. Base styling stays identical across desktop/mobile; callers only extend placement/width. */
export function PopoverPanel(props: { className?: string; children: JSX.Element }): JSX.Element {
  return <div class={cn("z-50", floatingSurfaceClasses, "bg-[var(--popover-bg)] p-3", props.className)}>{props.children}</div>;
}

