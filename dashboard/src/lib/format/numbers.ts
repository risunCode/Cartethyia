/**
 * Numeric display, in one place.
 *
 * These values used to be formatted by per-route copies that disagreed: four
 * `formatBytes` implementations chose different unit thresholds, decimal
 * counts and placeholders, so the same byte count rendered as "0 MB" on
 * Overview and "—" in Usage. One owner, one policy.
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

/** Bytes, scaled to B / KB / MB / GB / TB. One decimal above the base unit. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  // A negative count means the accounting is wrong upstream; keep it visible in
  // the base unit rather than clamping it to zero or rescaling it.
  if (bytes < 0) return `${Math.round(bytes)} B`;
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/** A probe/latency duration: `ms` below a second, `s` above, no space. */
export function formatProbeDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
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
