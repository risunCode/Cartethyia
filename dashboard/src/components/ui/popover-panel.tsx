/* @jsxImportSource solid-js */

import type { JSX } from "solid-js";
import { cn } from "../../lib/cn";
import { floatingSurfaceClasses } from "./styles";

/** Shared surface for floating controls. Base styling stays identical across desktop/mobile; callers only extend placement/width. */
export function PopoverPanel(props: { className?: string; children: JSX.Element }): JSX.Element {
  return <div class={cn("z-50", floatingSurfaceClasses, "bg-[var(--glass-bg-2)] p-3 backdrop-blur-[6px]", props.className)}>{props.children}</div>;
}
