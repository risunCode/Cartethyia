/** Formatting helpers for numbers, tokens, durations. */

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString("en-US");
}

export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return "\u2014";
  if (value >= 1_000_000_000_000) return `${(value / 1_000_000_000_000).toFixed(1)}T`;
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Auto-switches MB→GB past 1024 so a system-wide figure like 16,088 reads as "15.7 GB", not an ambiguous 5-digit MB number. */
export function formatMemoryMb(mb: number | null | undefined): string {
  if (mb === null || mb === undefined) return "—";
  if (mb >= 1024) return `${(mb / 1024).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} GB`;
  return `${mb.toLocaleString("en-US", { maximumFractionDigits: 0 })} MB`;
}

/** Renders "—" for exactly 0 — no matching usage (or none of it had a known rate) reads as "no estimate", not a confirmed $0.00 spend. */
export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || value === 0) return "—";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Renders whole-second uptime as "2d 4h", "4h 12m", "12m 05s", or "05s" — coarsest two units, matching how uptime is conventionally read. */
export function formatUptime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || seconds < 0 || !Number.isFinite(seconds)) return "—";
  const whole = Math.floor(seconds);
  const days = Math.floor(whole / 86_400);
  const hours = Math.floor((whole % 86_400) / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${String(secs).padStart(2, "0")}s`;
  return `${secs}s`;
}

/** Formats a kilobyte amount as "1.2 GB", "456 MB", or "12 KB" — auto-scaling like formatMemoryMb. */
export function formatBandwidthKb(kb: number | null | undefined): string {
  if (kb === null || kb === undefined || !Number.isFinite(kb)) return "—";
  if (kb >= 1_048_576) return `${(kb / 1_048_576).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} TB`;
  if (kb >= 1_024) return `${(kb / 1_024).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} GB`;
  return `${Math.round(kb).toLocaleString("en-US")} MB`;
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString("en-GB", { hour12: false });
}

/**
 * Parses a server timestamp into epoch milliseconds.
 * Server stores UTC timestamps as "YYYY-MM-DD HH:MM:SS" (no timezone suffix);
 * Date.parse() treats space-separated datetimes as LOCAL time in V8, so a
 * request from 5 min ago in UTC+7 would appear as "7h". Normalising to ISO-8601
 * with an explicit Z suffix ensures Date.parse() treats it as UTC regardless
 * of the client's timezone. Returns NaN when the value can't be parsed.
 */
export function parseServerTimestamp(value: string): number {
  const iso = value.includes("T") ? value : value.replace(" ", "T") + "Z";
  const ts = Date.parse(iso);
  return Number.isFinite(ts) ? ts : NaN;
}

/**
 * Renders a server timestamp as a coarse relative-time string ("3s ago",
 * "5m ago", "2h ago", "1d ago"). Falls back to formatTime when the value
 * can't be parsed. Callers should re-render roughly every second so the
 * label stays current — TimeAgo subscribes to a shared tick for this.
 */
export function formatRelativeTime(value: string): string {
  const timestamp = parseServerTimestamp(value);
  if (!Number.isFinite(timestamp)) return formatTime(value);
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (elapsedSeconds < 60) return `${Math.max(1, elapsedSeconds)}s ago`;
  if (elapsedSeconds < 3_600) return `${Math.floor(elapsedSeconds / 60)}m ago`;
  if (elapsedSeconds < 86_400) return `${Math.floor(elapsedSeconds / 3_600)}h ago`;
  return `${Math.floor(elapsedSeconds / 86_400)}d ago`;
}
