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
