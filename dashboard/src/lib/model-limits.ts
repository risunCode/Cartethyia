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
