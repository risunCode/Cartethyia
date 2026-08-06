import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/cn";
import { Card, type CardDensity } from "./card";
import { IconBadge, type IconTone } from "./icon";

export interface StatCardProps {
  label: string;
  value: ReactNode;
  description?: string;
  icon?: LucideIcon;
  tone?: IconTone;
  loading?: boolean;
  className?: string;
}

export function StatCard({ label, value, description, icon: Icon, tone = "accent", loading = false, className }: StatCardProps) {
  return (
    <Card density="compact" className={cn("min-w-0", className)}>
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">{label}</div>
          {loading ? <div className="mt-2 h-7 w-24 animate-pulse rounded bg-[var(--surface-muted)]" aria-label={`Loading ${label}`} /> : <div className="mt-1 text-xl font-bold tabular-nums">{value}</div>}
          {description && <div className="mt-1 truncate text-[11px] text-[var(--text-tertiary)]">{description}</div>}
        </div>
        {Icon && <IconBadge icon={Icon} tone={tone} size="md" />}
      </div>
    </Card>
  );
}

export type StatePanelKind = "loading" | "empty" | "error";

export interface StatePanelProps {
  kind: StatePanelKind;
  title?: string;
  description?: string;
  action?: ReactNode;
  icon?: LucideIcon;
  density?: CardDensity;
  className?: string;
}

const defaultCopy: Record<StatePanelKind, { title: string; description: string; tone: IconTone }> = {
  loading: { title: "Loading", description: "Please wait…", tone: "neutral" },
  empty: { title: "Nothing here yet", description: "There is no data to show.", tone: "neutral" },
  error: { title: "Unable to load", description: "Try again or check the connection.", tone: "danger" },
};

export function StatePanel({ kind, title, description, action, icon: Icon, density = "default", className }: StatePanelProps) {
  const copy = defaultCopy[kind];
  return (
    <Card density={density} className={cn("text-center", className)}>
      {Icon && <IconBadge icon={Icon} tone={copy.tone} size="md" className="mx-auto" />}
      <h2 className="mt-3 text-sm font-bold">{title ?? copy.title}</h2>
      <p className="mx-auto mt-1 max-w-md text-xs text-[var(--text-secondary)]" role={kind === "error" ? "alert" : "status"}>{description ?? copy.description}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </Card>
  );
}
