import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface SettingRowProps {
  label: string;
  description?: string;
  control: ReactNode;
  className?: string;
}

/** Aligns a setting's description and control across settings-like pages. */
export function SettingRow({ label, description, control, className }: SettingRowProps) {
  return (
    <div className={cn("flex flex-col gap-3 rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between", className)}>
      <div className="min-w-0">
        <div className="text-xs font-semibold text-[var(--text-1)]">{label}</div>
        {description && <div className="mt-0.5 text-[11px] leading-relaxed text-[var(--text-3)]">{description}</div>}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

export interface SettingSectionProps {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}

/** Groups related setting rows without coupling the section to a specific page. */
export function SettingSection({ title, description, children, className }: SettingSectionProps) {
  return (
    <section className={cn("space-y-3", className)}>
      <div>
        <h2 className="text-sm font-bold text-[var(--text-1)]">{title}</h2>
        {description && <p className="mt-0.5 text-[11px] text-[var(--text-3)]">{description}</p>}
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}
