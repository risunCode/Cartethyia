import { memo, useMemo, useState } from "react";
import { Activity, CheckCircle2, ChevronRight, Clock3, Search, ShieldAlert } from "lucide-react";
import { formatTime } from "../../lib/format";
import { Badge } from "../../components/ui/badge";
import { Card, CardHeader } from "../../components/ui/card";
import { Drawer } from "../../components/ui/drawer";
import { Input } from "../../components/ui/input";
import { Select, Tabs } from "../../components/ui/tabs";
import { isCanonicalRequestEvidence, type ConsoleEvidence, useConsoleObservability } from "../../composables/observability/use-console-observability";

const EVENT_OPTIONS = [
  { value: "all", label: "All lifecycle events" },
  { value: "incoming", label: "Incoming" },
  { value: "route", label: "Route" },
  { value: "provider_attempt", label: "Provider attempt" },
  { value: "success", label: "Success" },
  { value: "failure", label: "Failure" },
  { value: "retry", label: "Retry" },
  { value: "fallback", label: "Fallback" },
  { value: "token_refresh", label: "Token refresh" },
  { value: "cancellation", label: "Cancellation" },
  { value: "completion", label: "Completion" },
] as const;

type EventFilter = (typeof EVENT_OPTIONS)[number]["value"];
type View = "lifecycle" | "requests";

const LEVEL_TONES = { debug: "default", info: "info", warn: "warn", error: "err", unknown: "default" } as const;
const EVENT_LABELS: Record<ConsoleEvidence["event"], string> = {
  incoming: "Incoming",
  route: "Route",
  provider_attempt: "Provider attempt",
  success: "Success",
  failure: "Failure",
  retry: "Retry",
  fallback: "Fallback",
  token_refresh: "Token refresh",
  cancellation: "Cancellation",
  completion: "Completion",
  unknown: "Unknown event",
};

function eventIcon(event: ConsoleEvidence["event"]) {
  if (event === "failure" || event === "cancellation") return <ShieldAlert size={13} aria-hidden="true" />;
  if (event === "success" || event === "completion") return <CheckCircle2 size={13} aria-hidden="true" />;
  return <Activity size={13} aria-hidden="true" />;
}

function displayValue(value: string | number | null): string {
  return value === null || value === "" ? "Unknown" : String(value);
}

const EvidenceRow = memo(function EvidenceRow({ event, onOpen }: { event: ConsoleEvidence; onOpen: (event: ConsoleEvidence) => void }) {
  return (
    <button type="button" onClick={() => onOpen(event)} className="grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 border-b border-[var(--inner-border)] px-3 py-2.5 text-left transition-colors last:border-0 hover:bg-[var(--hover)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--focus-ring)]">
      <span className="mt-0.5 text-[var(--text-3)]">{eventIcon(event.event)}</span>
      <span className="min-w-0">
        <span className="flex min-w-0 flex-wrap items-center gap-1.5"><Badge tone={LEVEL_TONES[event.level]}>{EVENT_LABELS[event.event]}</Badge>{event.scope && <span className="truncate text-[10px] text-[var(--text-3)]">{event.scope}</span>}</span>
        <span className="mt-1 block truncate text-xs text-[var(--text-1)]">{event.message ?? "No bounded summary supplied"}</span>
        <span className="mt-1 flex min-w-0 flex-wrap gap-x-2 text-[10px] text-[var(--text-3)]">{event.provider && <span className="truncate">provider: {event.provider}</span>}{event.model && <span className="truncate">model: {event.model}</span>}{event.requestId && <span className="truncate">request: {event.requestId}</span>}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1 text-[10px] tabular-nums text-[var(--text-3)]"><span>{formatTime(event.timestamp)}</span><ChevronRight size={12} aria-hidden="true" /></span>
    </button>
  );
});

function StateNotice({ state, message }: { state: "loading" | "ready" | "degraded" | "unavailable"; message: string | null }) {
  if (state === "loading") return <div className="grid min-h-[260px] place-items-center text-sm text-[var(--text-3)]" role="status">Loading lifecycle evidence…</div>;
  if (state === "unavailable") return <div className="grid min-h-[260px] place-items-center px-4 text-center text-sm text-[var(--text-2)]" role="status"><span><strong className="text-[var(--text-1)]">Lifecycle evidence unavailable.</strong><br />The daemon has not advertised the V2 console-log contract.</span></div>;
  if (state === "degraded") return <div className="grid min-h-[260px] place-items-center px-4 text-center text-sm text-[var(--text-2)]" role="status"><span><strong className="text-[var(--orange)]">Lifecycle evidence degraded.</strong><br />{message ?? "The daemon could not provide a complete read model."}</span></div>;
  return null;
}

function EvidenceDrawer({ event, onClose }: { event: ConsoleEvidence | null; onClose: () => void }) {
  return <Drawer open={event !== null} onClose={onClose} title={event ? EVENT_LABELS[event.event] : "Lifecycle evidence"}>
    {event && <div className="space-y-4 text-xs"><p className="text-[var(--text-2)]">Bounded lifecycle evidence only. Prompts, credentials, headers, and provider bodies are never shown.</p><dl className="grid grid-cols-2 gap-3">{[
      ["Timestamp", event.timestamp], ["Level", event.level], ["Scope", event.scope], ["Request ID", event.requestId], ["Trace ID", event.traceId], ["Origin", event.origin], ["Client family", event.clientFamily], ["Method", event.method], ["Path", event.path], ["Provider", event.provider], ["Model", event.model], ["Status", event.status], ["Error code", event.errorCode], ["Latency", event.latencyMs === null ? null : `${event.latencyMs}ms`],
    ].map(([label, value]) => <div key={label}><dt className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">{label}</dt><dd className="mt-1 break-words font-mono text-[var(--text-1)]">{displayValue(value)}</dd></div>)}</dl><div className="rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-3"><div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Summary</div><p className="mt-1 break-words text-[var(--text-1)]">{event.message ?? "Unknown"}</p></div></div>}
  </Drawer>;
}

export function ConsoleLogPage() {
  const [view, setView] = useState<View>("lifecycle");
  const [eventFilter, setEventFilter] = useState<EventFilter>("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ConsoleEvidence | null>(null);
  const observability = useConsoleObservability();
  const events = observability.events;
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (events ?? []).filter((event) => {
      if (view === "requests" && !isCanonicalRequestEvidence(event)) return false;
      if (eventFilter !== "all" && event.event !== eventFilter) return false;
      if (!query) return true;
      return [event.event, event.level, event.scope, event.message, event.provider, event.model, event.requestId, event.path].some((value) => value?.toLowerCase().includes(query));
    });
  }, [eventFilter, events, search, view]);

  let stateTone: "ok" | "warn" | "err" | "info" = "info";
  if (observability.state === "ready") stateTone = "ok";
  if (observability.state === "degraded") stateTone = "warn";
  if (observability.state === "unavailable") stateTone = "err";

  return <div className="dashboard-page flex min-h-0 flex-1 flex-col gap-3 overflow-hidden pt-2 sm:pt-0"><div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-base font-bold">Console observability</h1><p className="mt-1 text-xs text-[var(--text-2)]">Structured lifecycle evidence from the V2 daemon read model.</p></div><Badge tone={stateTone}>{observability.state}</Badge></div><Tabs ariaLabel="Observability views" tabs={[{ id: "lifecycle", label: "Lifecycle evidence" }, { id: "requests", label: "Request Log · POST action" }]} value={view} onChange={(value) => setView(value as View)} /><Card className="flex min-h-0 flex-1 flex-col overflow-hidden p-0" surface="frame"><CardHeader title={view === "lifecycle" ? "Lifecycle Log" : "Request Log"} icon={view === "lifecycle" ? Activity : Clock3} sub={view === "lifecycle" ? "Incoming, routing, provider, retry, token, and completion evidence" : "Canonical client action evidence only"}><div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto"><div className="relative order-last w-full sm:order-none sm:w-48"><Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)]" aria-hidden="true" /><Input aria-label="Search observability evidence" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filter evidence" className="h-8 pl-8 pr-2 text-xs" /></div>{view === "lifecycle" && <Select ariaLabel="Lifecycle event" value={eventFilter} onChange={(value) => setEventFilter(value as EventFilter)} options={EVENT_OPTIONS.map((item) => ({ ...item }))} />}</div></CardHeader><StateNotice state={observability.state} message={observability.errorMessage} />{observability.state === "ready" && <div className="min-h-0 flex-1 overflow-y-auto" aria-live="polite">{visible.length === 0 ? <div className="grid min-h-[260px] place-items-center px-4 text-center text-sm text-[var(--text-3)]">No lifecycle evidence matches this view.</div> : visible.map((event) => <EvidenceRow key={event.id} event={event} onOpen={setSelected} />)}</div>}{observability.state === "ready" && <footer className="border-t border-[var(--inner-border)] bg-[var(--hover)] px-3 py-2 text-[10px] text-[var(--text-3)]">Showing {visible.length} of {(events ?? []).length} bounded events · refreshes automatically</footer>}</Card><EvidenceDrawer event={selected} onClose={() => setSelected(null)} /></div>;
}
