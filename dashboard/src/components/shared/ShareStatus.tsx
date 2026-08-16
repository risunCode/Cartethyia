
import { Show, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { useSSE } from "../../lib/sse";
import { cn } from "../../lib/cn";
import { formatRelativeTime, formatTime } from "../../lib/format";
import { Badge } from "../ui/badge";
import { ProgressBar } from "../patterns/progress-bar";

export type ShareStatusTone = "pending" | "active" | "expired" | "exhausted" | "paused";

export interface ShareStatusSnapshot {
  readonly id: string;
  readonly label: string;
  readonly tone: ShareStatusTone;
  readonly progress: number;
  readonly progressMax: number;
  readonly totalTokens: number;
  readonly totalRequests: number;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
  readonly inFlight?: number | null;
}

export interface ShareStatusProps {
  url: string;
  snapshot?: ShareStatusSnapshot | null;
  /** Named SSE event types delivered by the stream (e.g. ["count"] for share links). */
  events?: readonly string[];
  fallbackMessage?: string;
  className?: string;
}

const TONE_BADGE: Record<ShareStatusTone, "neutral" | "success" | "warning" | "danger" | "info"> = {
  pending: "info",
  active: "success",
  expired: "warning",
  exhausted: "danger",
  paused: "neutral",
};

const TONE_LABEL: Record<ShareStatusTone, string> = {
  pending: "Initializing",
  active: "Active",
  expired: "Expired",
  exhausted: "Quota exhausted",
  paused: "Paused",
};

const STALE_THRESHOLD_MS = 30_000;

let shareCounter = 0;

function readFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readOptionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseShareSnapshot(value: unknown, fallbackId: string): ShareStatusSnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const outer = value as Record<string, unknown>;
  const innerCandidate =
    typeof outer.snapshot === "object" && outer.snapshot !== null && !Array.isArray(outer.snapshot)
      ? (outer.snapshot as Record<string, unknown>)
      : outer;
  const toneRaw = readString(innerCandidate.tone)?.toLowerCase() ?? "pending";
  const tone: ShareStatusTone =
    toneRaw === "active" || toneRaw === "expired" || toneRaw === "exhausted" || toneRaw === "paused"
      ? (toneRaw as ShareStatusTone)
      : "pending";
  const id = readString(outer.id) ?? fallbackId;
  const label = readString(outer.label) ?? "Shared link";
  const progress = readFiniteNumber(innerCandidate.progress, 0);
  const progressMaxCandidate = readOptionalNumber(innerCandidate.progressMax);
  const totalTokens = readFiniteNumber(innerCandidate.totalTokens, 0);
  const totalRequests = readFiniteNumber(innerCandidate.totalRequests, 0);
  const createdAt = readString(outer.createdAt) ?? new Date().toISOString();
  const lastUsedAt = readString(innerCandidate.lastUsedAt);
  const expiresAt = readString(outer.expiresAt);
  return {
    id,
    label,
    tone,
    progress,
    progressMax: progressMaxCandidate !== null && progressMaxCandidate > 0 ? progressMaxCandidate : 100,
    totalTokens,
    totalRequests,
    createdAt,
    lastUsedAt,
    expiresAt,
  };
}

/**
 * Live status indicator for a share link. Renders SSE-pushed snapshot state
 * (tone, progress, totals) with a static fallback supplied by the caller for
 * the first paint before any stream event arrives.
 */
export function ShareStatus(props: ShareStatusProps): JSX.Element {
  const [liveSnapshot, setLiveSnapshot] = createSignal<ShareStatusSnapshot | null>(null);
  const [lastEventAt, setLastEventAt] = createSignal<number | null>(null);

  const sseState = useSSE(props.url, {
    events: props.events ? [...props.events] : undefined,
    onMessage: (event) => {
      let payload: unknown = event;
      if (event && typeof event === "object" && "data" in event) {
        payload = event.data;
      }
      shareCounter += 1;
      const parsed = parseShareSnapshot(payload, `share-${shareCounter}`);
      if (parsed) {
        setLiveSnapshot(parsed);
        setLastEventAt(Date.now());
        return;
      }
      // Count-style stream payloads ({"inFlight":N}) refresh the live
      // in-flight figure without carrying a full snapshot.
      if (typeof payload === "object" && payload !== null) {
        const inFlight = readOptionalNumber((payload as Record<string, unknown>).inFlight);
        if (inFlight !== null) {
          setLiveSnapshot((current) => (current ? { ...current, inFlight } : current));
          setLastEventAt(Date.now());
        }
      }
    },
  });

  const snapshot = createMemo<ShareStatusSnapshot | null>(() => liveSnapshot() ?? props.snapshot ?? null);

  // A 30-second stale window marks the link as paused when no SSE event has
  // arrived and the connection reports itself healthy — protects operators
  // from assuming "active" when the gateway has silently gone quiet.
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 5_000);
    onCleanup(() => window.clearInterval(interval));
  });
  const isStale = createMemo(() => {
    const last = lastEventAt();
    if (last === null) return false;
    return now() - last > STALE_THRESHOLD_MS;
  });

  const progressTone = (): "accent" | "warning" | "danger" => {
    const current = snapshot();
    if (!current) return "accent";
    if (current.tone === "exhausted") return "danger";
    if (current.tone === "expired" || current.tone === "paused") return "warning";
    return "accent";
  };

  return (
    <div
      class={cn(
        "share-fade-in flex flex-col gap-4 rounded-[var(--radius-card)] border border-[var(--inner-border)] bg-[var(--surface-1)] p-4",
        props.className,
      )}
    >
      <header class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="text-[10px] font-bold uppercase tracking-wider text-[var(--text-3)]">Share link</div>
          <h3 class="mt-1 truncate text-[15px] font-semibold text-[var(--text-1)]">
            {snapshot()?.label ?? "Pending share"}
          </h3>
          <Show when={snapshot()?.id}>
            {(id) => <div class="mt-0.5 truncate font-mono text-[11px] text-[var(--text-3)]">{id()}</div>}
          </Show>
        </div>
        <Badge tone={TONE_BADGE[snapshot()?.tone ?? "pending"]}>
          {TONE_LABEL[snapshot()?.tone ?? "pending"]}
        </Badge>
      </header>

      <div class="flex items-center gap-2 text-[11px] text-[var(--text-3)]">
        <span
          class={cn(
            "inline-block h-1.5 w-1.5 rounded-full",
            sseState.state().connected
              ? isStale()
                ? "bg-[var(--status-warning)]"
                : "bg-[var(--status-success)]"
              : "bg-[var(--status-danger)]",
          )}
          aria-hidden="true"
        />
        <span>
          {sseState.state().connected
            ? isStale()
              ? "Quiet — no recent events"
              : "Live status stream connected"
            : sseState.state().reconnecting
            ? "Reconnecting…"
            : "Stream offline"}
        </span>
        <Show when={lastEventAt()}>
          {(stamp) => <span>· last event {formatRelativeTime(new Date(stamp()).toISOString())}</span>}
        </Show>
      </div>

      <Show
        when={snapshot()}
        fallback={
          <p class="text-[12px] text-[var(--text-3)]">
            {props.fallbackMessage ?? "Awaiting first status update…"}
          </p>
        }
      >
        {(current) => (
          <div class="flex flex-col gap-3">
            <ProgressBar
              value={current().progress}
              max={current().progressMax}
              tone={progressTone()}
              label="Quota used"
              showValue
            />

            <dl class="grid grid-cols-2 gap-3 text-[11.5px] sm:grid-cols-3">
              <Stat label="Total requests" value={current().totalRequests.toLocaleString("en-US")} />
              <Stat label="Total tokens" value={current().totalTokens.toLocaleString("en-US")} />
              <Show when={current().inFlight !== null && current().inFlight !== undefined}>
                <Stat label="In-flight" value={(current().inFlight ?? 0).toLocaleString("en-US")} />
              </Show>
              <Stat label="Created" value={formatTime(current().createdAt)} />
              <Show when={current().lastUsedAt}>
                {(stamp) => <Stat label="Last used" value={formatRelativeTime(stamp())} />}
              </Show>
              <Show when={current().expiresAt}>
                {(stamp) => <Stat label="Expires" value={formatTime(stamp())} />}
              </Show>
            </dl>
          </div>
        )}
      </Show>

      <Show when={sseState.state().error}>
        {(message) => (
          <p class="text-[11px] text-[var(--status-danger)]" role="alert">
            Stream error: {message()}
          </p>
        )}
      </Show>
    </div>
  );
}

function Stat(props: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <dt class="text-[10px] font-bold uppercase tracking-wider text-[var(--text-3)]">{props.label}</dt>
      <dd class="mt-0.5 text-[12px] font-semibold text-[var(--text-1)]">{props.value}</dd>
    </div>
  );
}
