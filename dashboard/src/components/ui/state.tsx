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

const statIconToneClasses: Record<IconTone, string> = {
  neutral: "text-[var(--text-3)]",
  accent: "text-[var(--accent)]",
  success: "text-[var(--status-success)]",
  warning: "text-[var(--status-warning)]",
  danger: "text-[var(--status-danger)]",
  info: "text-[var(--status-info)]",
};

export function StatCard({ label, value, description, icon: Icon, tone = "accent", loading = false, className }: StatCardProps) {
  return (
    <Card density="compact" className={cn("min-w-0", className)}>
      <div className="flex min-w-0 items-center gap-1.5 text-[var(--text-3)]">
        {Icon && <Icon size={13} className={statIconToneClasses[tone]} aria-hidden={true} />}
        <div className="truncate text-[10px] font-semibold uppercase tracking-wider">{label}</div>
      </div>
      {loading ? <div className="mt-2 h-6 w-24 animate-pulse rounded bg-[var(--surface-muted)]" aria-label={`Loading ${label}`} /> : <div className="mt-1 text-lg font-bold tabular-nums text-[var(--text-1)]">{value}</div>}
      {description && <div className="text-[10px] text-[var(--text-3)]">{description}</div>}
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
