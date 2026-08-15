/* @jsxImportSource solid-js */

import type { JSX } from "solid-js";
import { cn } from "../../lib/cn";

export interface SettingRowProps {
  label: string;
  description?: string;
  control: JSX.Element;
  className?: string;
}

/** Aligns a setting's description and control across settings-like pages. */
export function SettingRow(props: SettingRowProps): JSX.Element {
  return (
    <div class={cn("flex flex-col gap-3 rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between", props.className)}>
      <div class="min-w-0">
        <div class="text-xs font-semibold text-[var(--text-1)]">{props.label}</div>
        {props.description && <div class="mt-0.5 text-[11px] leading-relaxed text-[var(--text-3)]">{props.description}</div>}
      </div>
      <div class="shrink-0">{props.control}</div>
    </div>
  );
}

export interface SettingSectionProps {
  title: string;
  description?: string;
  children: JSX.Element;
  className?: string;
}

/** Groups related setting rows without coupling the section to a specific page. */
export function SettingSection(props: SettingSectionProps): JSX.Element {
  return (
    <section class={cn("space-y-3", props.className)}>
      <div>
        <h2 class="text-sm font-bold text-[var(--text-1)]">{props.title}</h2>
        {props.description && <p class="mt-0.5 text-[11px] text-[var(--text-3)]">{props.description}</p>}
      </div>
      <div class="space-y-2">{props.children}</div>
    </section>
  );
}
