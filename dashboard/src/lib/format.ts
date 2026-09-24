/**
 * The dashboard's single source of truth for display formatting.
 *
 * These values used to be formatted by per-route copies that disagreed: four
 * `formatBytes` implementations chose different unit thresholds, decimal
 * counts and placeholders, so the same byte count rendered as "0 MB" on
 * Overview, "1536B" in Studio, and "—" in Usage. One owner, one policy.
 *
 * Policy: an absent or non-finite value is `—`; zero is a real measurement.
 */

/** Bytes, scaled to B / KB / MB. One decimal above the base unit. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A millisecond duration: `ms` below a second, `s` above. */
export function formatDuration(milliseconds: number | null | undefined): string {
  if (milliseconds === null || milliseconds === undefined || !Number.isFinite(milliseconds)) {
    return "—";
  }
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1000).toFixed(1)} s`;
}

/** A count of seconds as `1d 2h` / `3h 4m` / `5m 6s` / `7s`, dropping zero units. */
export function formatUptime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const whole = Math.max(0, Math.floor(seconds));
  const days = Math.floor(whole / 86_400);
  const hours = Math.floor((whole % 86_400) / 3_600);
  const minutes = Math.floor((whole % 3_600) / 60);
  const secs = whole % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

/** A plain integer count with thousands separators. */
export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString("en-US");
}

/**
 * Token counts are the dashboard's one abbreviated number: a raw `1_234_567`
 * is unreadable in a chart axis or a breakdown row. `TOKEN_SCALES` is ordered
 * coarsest-first, and the last index (`RAW_TOKEN_SCALE`) is the exact count.
 * Usage's scale switcher pins one unit; `TOKEN_SCALE_AUTO` picks the unit a
 * value lands on.
 */
export const TOKEN_SCALES = [
  { threshold: 1_000_000_000_000, divisor: 1_000_000_000_000, suffix: "T" },
  { threshold: 1_000_000_000, divisor: 1_000_000_000, suffix: "B" },
  { threshold: 1_000_000, divisor: 1_000_000, suffix: "M" },
  { threshold: 1_000, divisor: 1_000, suffix: "K" },
] as const;

/** Index past the last scale: show the exact token count. */
export const RAW_TOKEN_SCALE = TOKEN_SCALES.length;
/** Sentinel for the compact unit the value lands on. */
export const TOKEN_SCALE_AUTO = -1;
export const DEFAULT_TOKEN_SCALE = RAW_TOKEN_SCALE;

/** Index into `TOKEN_SCALES` for the compact unit a token count lands on. */
export function tokenScaleIndex(value: number): number {
  const abs = Math.abs(value);
  const found = TOKEN_SCALES.findIndex((scale) => abs >= scale.threshold);
  return found === -1 ? TOKEN_SCALES.length : found;
}

/** Formats a token count at `TOKEN_SCALES[index]`; the last index is the raw count. */
function formatScaled(value: number, index: number): string {
  const scale = TOKEN_SCALES[index];
  if (!scale) return Math.round(value).toLocaleString("en-US");
  const scaled = value / scale.divisor;
  return `${scaled.toLocaleString("en-US", {
    maximumFractionDigits: index === TOKEN_SCALES.length - 1 ? 0 : 1,
  })}${scale.suffix}`;
}

/** A token count in the compact unit it lands on (`1.2K`, `3.4M`), or the exact count. */
export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return formatScaled(value, tokenScaleIndex(value));
}

/**
 * Formats a token count at the card's scale: `TOKEN_SCALE_AUTO` picks the
 * compact unit the value lands on, `RAW_TOKEN_SCALE` is the exact count, and
 * anything else pins one of `TOKEN_SCALES`.
 */
export function tokenScaleValue(value: number | null | undefined, scale: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (scale === TOKEN_SCALE_AUTO) return formatScaled(value, tokenScaleIndex(value));
  if (scale === RAW_TOKEN_SCALE) return Math.round(value).toLocaleString("en-US");
  return formatScaled(value, scale);
}
