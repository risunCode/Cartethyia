/**
 * Compact display formatters for token counts and limit values.
 *
 * One home for the `compactTokens`/`limitLabel` pair that had been duplicated
 * per component; the console surfaces it in credential rows, share
 * management, and quota displays.
 */

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
