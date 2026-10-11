/**
 * Token-count display, in one place.
 *
 * Three spellings of the same idea used to live apart — the compact scale, a
 * `compactTokens` copy, and a model-window formatter — so a 3,441-token account
 * read `3.4K` in one row and `3.44K` in the next. They sit side by side here
 * rather than being merged, because each one's rounding is what a surface is
 * built around; changing one to match another is a behavior change, not a
 * rename.
 *
 * Pick by what the surface shows:
 *
 * - {@link formatTokens} / {@link tokenScaleValue} — a count on a chart axis or
 *   a usage breakdown, locale-grouped, with a scale switcher.
 * - {@link compactTokens} — a credential row or share limit: two decimals, no
 *   locale, never negative.
 * - {@link formatModelTokens} — a model's context or output window on a catalog
 *   card: `400k`, `1.0M`.
 *
 * Policy everywhere: an absent or non-finite value is `—`; zero is a real
 * measurement.
 */

/**
 * Ordered coarsest-first. The last index ({@link RAW_TOKEN_SCALE}) is the exact
 * count. Usage's scale switcher pins one unit; `TOKEN_SCALE_AUTO` picks the
 * unit a value lands on.
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

/** Compact K/M/B/T token count, e.g. 3441 → "3.44K". */
export function compactTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const amount = Math.max(0, value);
  if (amount >= 1_000_000_000_000) return `${Number((amount / 1_000_000_000_000).toFixed(2))}T`;
  if (amount >= 1_000_000_000) return `${Number((amount / 1_000_000_000).toFixed(2))}B`;
  if (amount >= 1_000_000) return `${Number((amount / 1_000_000).toFixed(2))}M`;
  if (amount >= 1_000) return `${Number((amount / 1_000).toFixed(2))}K`;
  return amount.toLocaleString();
}

/** A configured limit; `null`/`undefined` reads as "Unlimited". */
export function limitLabel(value: number | null | undefined): string {
  if (value === null || value === undefined) return "Unlimited";
  return Number.isFinite(value) ? value.toLocaleString() : "—";
}

/**
 * Unknown-limit display for model cards.
 *
 * Backend keeps `contextLimit`/`outputLimit` as `null` when upstream supplied
 * no metadata (string-only discovery, manual register). Cards render those as
 * unavailable rather than guessing a number: a made-up 200k/64k looks measured
 * and misleads capacity planning. Never used for routing or request shaping —
 * display only.
 */
export const UNKNOWN_LIMITS_TOOLTIP =
  "Upstream provided no context metadata; limits are unavailable, not estimated.";

/**
 * A model limit as a card shows it: `400k`, `1.0M`.
 *
 * One owner for the two cards that draw these numbers — the provider catalog
 * and the public share page — so the same model cannot read `400k` on one and
 * `400K` on the other. An absent limit is `—`; a card that wants to explain the
 * absence renders `n/a` beside {@link UNKNOWN_LIMITS_TOOLTIP} instead of calling
 * this with `null`.
 */
export function formatModelTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}k`;
  return String(value);
}
