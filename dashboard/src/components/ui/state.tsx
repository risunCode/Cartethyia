
import type { JSX } from "solid-js";
import type { LucideIcon } from "lucide-solid";
import { cn } from "../../lib/cn";
import { Card, type CardDensity } from "./card";
import { IconBadge, type IconTone } from "./icon";

export interface StatCardProps {
  label: string;
  value: JSX.Element;
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

/** A compact metric card for overview and usage summaries. */
export function StatCard(props: StatCardProps): JSX.Element {
  const Icon = props.icon;
  const tone = () => props.tone ?? "accent";
  return (
    <Card density="compact" className={cn("min-w-0", props.className)}>
      <div class="flex min-w-0 items-center gap-1.5 text-[var(--text-3)]">
        {Icon && <Icon size={13} class={statIconToneClasses[tone()]} aria-hidden="true" />}
        <div class="truncate text-[10px] font-semibold uppercase tracking-wider">{props.label}</div>
      </div>
      {props.loading ? <div class="mt-2 h-6 w-24 animate-pulse rounded bg-[var(--surface-muted)]" aria-label={`Loading ${props.label}`} /> : <div class="mt-1 text-lg font-bold tabular-nums text-[var(--text-1)]">{props.value}</div>}
      {props.description && <div class="text-[10px] text-[var(--text-3)]">{props.description}</div>}
    </Card>
  );
}

export type StatePanelKind = "loading" | "empty" | "error" | "degraded";

export interface StatePanelProps {
  kind: StatePanelKind;
  title?: string;
  description?: string;
  action?: JSX.Element;
  icon?: LucideIcon;
  density?: CardDensity;
  className?: string;
}

const defaultCopy: Record<StatePanelKind, { title: string; description: string; tone: IconTone }> = {
  loading: { title: "Loading", description: "Please wait…", tone: "neutral" },
  empty: { title: "Nothing here yet", description: "There is no data to show.", tone: "neutral" },
  error: { title: "Unable to load", description: "Try again or check the connection.", tone: "danger" },
  degraded: { title: "Data unavailable", description: "The API is running but this capability is currently degraded.", tone: "warning" },
};

/** A standard loading, empty, error, or degraded state panel. */
export function StatePanel(props: StatePanelProps): JSX.Element {
  const copy = () => defaultCopy[props.kind];
  const Icon = props.icon;
  return (
    <Card density={props.density ?? "default"} className={cn("text-center", props.className)}>
      {Icon && <IconBadge icon={Icon} tone={copy().tone} size="md" className="mx-auto" />}
      <h2 class="mt-3 text-sm font-bold">{props.title ?? copy().title}</h2>
      <p class="mx-auto mt-1 max-w-md text-xs text-[var(--text-secondary)]" role={props.kind === "error" ? "alert" : "status"}>{props.description ?? copy().description}</p>
      {props.action && <div class="mt-4 flex justify-center">{props.action}</div>}
    </Card>
  );
}
