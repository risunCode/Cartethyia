/* @jsxImportSource solid-js */

import { splitProps, type JSX } from "solid-js";
import { cn } from "../../lib/cn";

export interface ActionGroupProps extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "align"> {
  align?: "start" | "end";
  density?: "compact" | "default";
  className?: string;
}

export function ActionGroup(props: ActionGroupProps): JSX.Element {
  const [local, rest] = splitProps(props, ["align", "density", "className"]);
  return <div {...rest} class={cn("flex min-w-0 flex-wrap items-center", local.align === "end" ? "justify-end" : "justify-start", local.density === "compact" ? "gap-1.5" : "gap-2", local.className)} />;
}

export interface DataTableProps extends JSX.HTMLAttributes<HTMLTableElement> {
  minWidth?: number;
  label?: string;
  className?: string;
}

export function DataTable(props: DataTableProps): JSX.Element {
  const [local, rest] = splitProps(props, ["minWidth", "label", "className"]);
  return (
    <div class="min-w-0 max-w-full overflow-x-auto overscroll-x-contain scrollbar-none" role={local.label ? "region" : undefined} aria-label={local.label} tabIndex={local.label ? 0 : undefined}>
      <table class={cn("w-full border-collapse text-left text-xs", local.className)} style={{ "min-width": `${local.minWidth ?? 640}px` }} {...rest} />
    </div>
  );
}
