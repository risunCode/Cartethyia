
import type { JSX } from "solid-js";
import { Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Activity } from "lucide-solid";
import { Badge } from "../ui/badge";
import { StatusIndicator } from "../ui/icon";
import { cn } from "../../lib/cn";
import { subscribeTimeTick } from "../../lib/time-tick";

export type FooterStatus = "active" | "degraded" | "down" | "offline" | "unknown";

export interface FooterProps {
  /** Current API/system status. */
  status?: FooterStatus;
  /** Optional version string (e.g. "1.4.2"). */
  version?: string;
  /** Optional uptime in seconds; rendered with formatUptime-equivalent logic. */
  uptimeSeconds?: number;
  /** Show live wall-clock; defaults to true. */
  showClock?: boolean;
  /** Optional extra slot rendered on the right. */
  trailing?: JSX.Element;
  className?: string;
}

const statusTone: Record<FooterStatus, Parameters<typeof Badge>[0]["tone"]> = {
  active: "success",
  degraded: "warning",
  down: "danger",
  offline: "neutral",
  unknown: "neutral",
};

const statusLabel: Record<FooterStatus, string> = {
  active: "Operational",
  degraded: "Degraded",
  down: "Down",
  offline: "Offline",
  unknown: "Unknown",
};

const indicatorStatus: Record<FooterStatus, "ok" | "warn" | "error" | "offline"> = {
  active: "ok",
  degraded: "warn",
  down: "error",
  offline: "offline",
  unknown: "offline",
};

const formatUptime = (seconds: number | undefined): string => {
  if (seconds === undefined || seconds < 0 || !Number.isFinite(seconds)) return "—";
  const whole = Math.floor(seconds);
  const days = Math.floor(whole / 86_400);
  const hours = Math.floor((whole % 86_400) / 3600);
  const minutes = Math.floor((whole % 3_600) / 60);
  const secs = whole % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${String(secs).padStart(2, "0")}s`;
  return `${secs}s`;
};

const formatClock = (date: Date): string =>
  date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

/**
 * Footer — status bar with optional version, uptime, and a 1Hz wall-clock.
 *
 * Uses the shared `subscribeTimeTick` clock so multiple Footers (or any other
 * subscribers) share a single rAF loop instead of starting one setInterval
 * per mount.
 */
export function Footer(props: FooterProps): JSX.Element {
  const showClock = (): boolean => props.showClock !== false;
  const [now, setNow] = createSignal<Date>(new Date());

  onMount(() => {
    const unsubscribe = subscribeTimeTick(() => setNow(new Date()));
    onCleanup(unsubscribe);
  });

  const status = (): FooterStatus => props.status ?? "unknown";
  const clock = createMemo(() => formatClock(now()));

  return (
    <footer
      role="contentinfo"
      aria-label="Dashboard footer"
      class={cn(
        "component-fade-in flex h-9 items-center gap-3 border-t border-[var(--inner-border)] bg-[var(--glass-bg)] px-3 text-[11px] text-[var(--text-2)] backdrop-blur-md",
        props.className,
      )}
    >
      <div class="flex min-w-0 items-center gap-2">
        <StatusIndicator status={indicatorStatus[status()]} aria-label={`Status: ${statusLabel[status()]}`} />
        <Activity size={12} class="text-[var(--text-3)]" aria-hidden="true" />
        <Badge tone={statusTone[status()]}>{statusLabel[status()]}</Badge>
      </div>

      <Show when={props.version}>
        {(version) => (
          <span class="hidden items-center gap-1 sm:inline-flex" aria-label={`Version ${version()}`}>
            <span class="text-[var(--text-3)]">v</span>
            <span class="font-mono tabular-nums">{version()}</span>
          </span>
        )}
      </Show>

      <Show when={props.uptimeSeconds !== undefined}>
        <span class="hidden items-center gap-1 md:inline-flex" aria-label={`Uptime ${formatUptime(props.uptimeSeconds)}`}>
          <span class="text-[var(--text-3)]">uptime</span>
          <span class="font-mono tabular-nums">{formatUptime(props.uptimeSeconds)}</span>
        </span>
      </Show>

      <div class="ml-auto flex items-center gap-3">
        <Show when={props.trailing}>{props.trailing}</Show>
        <Show when={showClock()}>
          <span
            class="inline-flex items-center gap-1 font-mono tabular-nums text-[var(--text-2)]"
            aria-label={`Current time ${clock()}`}
            title={clock()}
          >
            <span aria-hidden="true" class="h-1.5 w-1.5 rounded-full bg-[var(--status-success)]" />
            {clock()}
          </span>
        </Show>
      </div>
    </footer>
  );
}
