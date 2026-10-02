/**
 * The dashboard's single source of truth for display formatting.
 *
 * These values used to be formatted by per-route copies that disagreed: four
 * `formatBytes` implementations chose different unit thresholds, decimal
 * counts and placeholders, so the same byte count rendered as "0 MB" on
 * Overview, "1536B" in Studio, and "—" in Usage. One owner, one policy.
 *
 * Policy: an absent or non-finite value is `—`; zero is a real measurement.
 *
 * Numbers group by the viewer's locale, so the separators read unambiguously:
 * a hardcoded `en-US` renders `4,093.36`, whose comma a reader used to
 * `.`-thousands / `,`-decimals reads as either four thousand or four million.
 * The viewer's locale renders `4.093,36` for them instead. Every formatter
 * takes an optional explicit `locale` so a test can pin one reading; production
 * callers omit it and follow the browser.
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

/** A plain integer count with thousands separators, grouped by the viewer's locale. */
export function formatNumber(value: number | null | undefined, locale?: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString(locale);
}

/**
 * A credit/currency amount: the exact value with thousands separators, never
 * abbreviated.
 *
 * Credits are money, not a token count, so the compact `1.2K` scale that suits
 * a chart axis reads as a rounded-off balance an operator cannot reconcile
 * against the provider's own billing page. Two fraction digits are kept because
 * providers bill fractional credits (e.g. `1234.56`); whole amounts render
 * without a trailing `.00`. The separators follow the viewer's locale, so a
 * reader whose convention is `.`-thousands / `,`-decimals sees `4.093,36`
 * rather than the ambiguous `4,093.36`.
 */
export function formatCredits(value: number | null | undefined, locale?: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString(locale, { maximumFractionDigits: 2 });
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
function formatScaled(value: number, index: number, locale?: string): string {
  const scale = TOKEN_SCALES[index];
  if (!scale) return Math.round(value).toLocaleString(locale);
  const scaled = value / scale.divisor;
  return `${scaled.toLocaleString(locale, {
    maximumFractionDigits: index === TOKEN_SCALES.length - 1 ? 0 : 1,
  })}${scale.suffix}`;
}

/** A token count in the compact unit it lands on (`1.2K`, `3.4M`), or the exact count. */
export function formatTokens(value: number | null | undefined, locale?: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return formatScaled(value, tokenScaleIndex(value), locale);
}

/**
 * Formats a token count at the card's scale: `TOKEN_SCALE_AUTO` picks the
 * compact unit the value lands on, `RAW_TOKEN_SCALE` is the exact count, and
 * anything else pins one of `TOKEN_SCALES`.
 */
export function tokenScaleValue(value: number | null | undefined, scale: number, locale?: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (scale === TOKEN_SCALE_AUTO) return formatScaled(value, tokenScaleIndex(value), locale);
  if (scale === RAW_TOKEN_SCALE) return Math.round(value).toLocaleString(locale);
  return formatScaled(value, scale, locale);
}

/**
 * An instant's clock fields, read in `timeZone`, keyed by `formatToParts` type.
 * `formatToParts` is used instead of `format` because a plain `format()` reorders
 * the fields per locale (`01/10, 23:00` for en-GB) and a chart needs one fixed
 * shape. `hourCycle: "h23"` keeps local midnight at `00:00`, not `24:00`.
 */
function instantParts(
  date: Date,
  locale: string | undefined,
  timeZone: string | undefined,
  named: boolean,
): Record<string, string> {
  const options: Intl.DateTimeFormatOptions = {
    timeZone,
    hourCycle: "h23",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  };
  if (named) {
    options.year = "numeric";
    options.timeZoneName = "shortOffset";
  }
  const byType: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat(locale, options).formatToParts(date)) {
    byType[part.type] = part.value;
  }
  return byType;
}

/**
 * The chart's default display zone. Usage -> Traffic is always read in WIB, so
 * the axis is pinned here rather than to the browser's zone: an operator in
 * UTC+1 would otherwise see each bucket an hour off, and a UTC reader seven.
 */
export const CHART_TIME_ZONE = "Asia/Jakarta";

/**
 * The chart's X-axis tick: `MM-DD HH:mm`, in `timeZone`, defaulting to
 * `CHART_TIME_ZONE` (Asia/Jakarta, WIB, UTC+7) because Usage -> Traffic is read
 * in WIB, not the browser's zone.
 *
 * Buckets arrive as ISO-8601 UTC strings and stay that way on the wire — a
 * stored timestamp carries no zone of its own — so the conversion belongs at
 * render time. Without it a UTC+7 operator reads an axis seven hours behind
 * their wall clock; a `slice()` on the ISO string also leaves the literal `T`
 * in the label. An explicit `timeZone` overrides the default for a test that
 * pins one reading, mirroring `locale` above.
 */
export function formatChartTick(value: string, locale?: string, timeZone: string = CHART_TIME_ZONE): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = instantParts(date, locale, timeZone, false);
  return `${parts.month ?? ""}-${parts.day ?? ""} ${parts.hour ?? ""}:${parts.minute ?? ""}`;
}

/**
 * The chart tooltip's label: `YYYY-MM-DD HH:mm GMT+X`, in `timeZone`,
 * defaulting to `CHART_TIME_ZONE` (Asia/Jakarta, WIB, UTC+7) for the same
 * reason as the tick: Usage -> Traffic is read in WIB, not the browser's zone.
 * An explicit `timeZone` overrides the default for a test that pins one reading.
 *
 * The tick is compact and carries no zone, so the tooltip names the offset —
 * otherwise a bare `23:00` is unreadable as either local or UTC, and the tick
 * and tooltip could silently disagree about which clock they show.
 */
export function formatChartTooltip(value: string, locale?: string, timeZone: string = CHART_TIME_ZONE): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = instantParts(date, locale, timeZone, true);
  return `${parts.year ?? ""}-${parts.month ?? ""}-${parts.day ?? ""} ${parts.hour ?? ""}:${parts.minute ?? ""} ${parts.timeZoneName ?? ""}`;
}
