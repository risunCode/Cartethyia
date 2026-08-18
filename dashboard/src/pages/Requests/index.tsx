import { Activity, CheckCircle2, Clock3, Download, ListChecks } from "lucide-solid";
import type { JSX } from "solid-js";
import { Card, CardHeader } from "@components/ui/card";
import { Badge } from "@components/ui/badge";
import { MetricCard } from "@components/shared/MetricCard";
import { StatePanel } from "@components/ui/state";

const TASK_STATES = [
  { label: "Queued", value: "queued", tone: "neutral" as const },
  { label: "Downloading", value: "downloading", tone: "info" as const },
  { label: "Assembling", value: "assembling", tone: "warning" as const },
  { label: "Completed", value: "completed", tone: "success" as const },
];

/** Request/task monitoring skeleton based on the downloader task lifecycle. */
export default function Requests(): JSX.Element {
  return (
    <div class="dashboard-page animate-fade-in space-y-5">
      <header class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 class="text-xl font-bold text-[var(--text-1)]">Requests</h2>
          <p class="mt-1 text-xs text-[var(--text-2)]">Track extraction and download tasks through their lifecycle.</p>
        </div>
        <Badge tone="neutral">Skeleton monitor</Badge>
      </header>

      <section aria-label="Request summary" class="grid grid-cols-2 gap-3 card-stagger lg:grid-cols-4">
        <MetricCard label="Total requests" value="—" icon={ListChecks} tone="accent" description="Current window" />
        <MetricCard label="In progress" value="—" icon={Activity} tone="info" description="Queued or active" />
        <MetricCard label="Completed" value="—" icon={CheckCircle2} tone="success" description="Ready to deliver" />
        <MetricCard label="Average time" value="—" icon={Clock3} tone="warning" description="Until completion" />
      </section>

      <section class="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(300px,.8fr)]">
        <Card density="compact">
          <CardHeader title="Task queue" icon={ListChecks} iconColor="var(--accent)" sub="Queued, active, and recently completed extraction tasks" />
          <StatePanel
            kind="empty"
            title="No requests yet"
            description="Requests will appear here after the Proxy workspace submits an extraction task."
            icon={ListChecks}
            density="compact"
          />
        </Card>

        <Card density="compact">
          <CardHeader title="Task lifecycle" icon={Activity} iconColor="var(--status-info)" sub="Downloader engine states" />
          <div class="space-y-2">
            {TASK_STATES.map((state, index) => (
              <div class="flex items-center gap-2.5 rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2.5">
                <span class="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--surface-muted)] text-[10px] font-bold text-[var(--text-3)]">{index + 1}</span>
                <span class="min-w-0 flex-1 text-xs font-semibold text-[var(--text-2)]">{state.label}</span>
                <Badge tone={state.tone}>{state.value}</Badge>
              </div>
            ))}
          </div>
        </Card>
      </section>

      <Card density="compact">
        <CardHeader title="Delivery details" icon={Download} iconColor="var(--status-success)" sub="Media metadata will be shown per completed task" />
        <div class="grid gap-2 text-[11px] sm:grid-cols-2 lg:grid-cols-4">
          <Detail label="Progress" value="Downloaded bytes / total size" />
          <Detail label="Variants" value="Quality, extension, dimensions" />
          <Detail label="Fallback" value="Native extractor → external profile" />
          <Detail label="Errors" value="Auth, timeout, unsupported, upstream" />
        </div>
      </Card>
    </div>
  );
}

function Detail(props: { label: string; value: string }): JSX.Element {
  return (
    <div class="rounded-[var(--radius-control)] border border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2.5">
      <div class="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">{props.label}</div>
      <div class="mt-1 text-[var(--text-2)]">{props.value}</div>
    </div>
  );
}
