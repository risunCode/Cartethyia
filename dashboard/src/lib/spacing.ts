/**
 * The spacing scale, shared by every layout primitive so a gap is a utility and
 * never an inline style.
 *
 * `tokens.css` pins `--spacing: 2px`, which makes Tailwind's numeric spacing
 * utilities arithmetic: `gap-4` resolves to `calc(var(--spacing) * 4)` = 8px, and
 * every step below is one scale unit = 2px. The pixel values the sheets and the
 * older inline styles carried map onto it mechanically (`8px` → `gap-4`), so a
 * primitive can accept either form and still emit a utility.
 *
 * Anything genuinely off the 2px step — a border-derived inset, a percentage, a
 * `calc()` — is not in the map on purpose. Those keep an explicit escape hatch on
 * the component (`gapRaw`) rather than silently becoming an arbitrary utility that
 * the style guard would have to allowlist.
 */
const GAP_SCALE: Readonly<Record<number, string>> = {
  0: "gap-0",
  1: "gap-0.5",
  2: "gap-1",
  3: "gap-1.5",
  4: "gap-2",
  5: "gap-2.5",
  6: "gap-3",
  7: "gap-3.5",
  8: "gap-4",
  9: "gap-4.5",
  10: "gap-5",
  12: "gap-6",
  14: "gap-7",
  16: "gap-8",
  18: "gap-9",
  20: "gap-10",
  24: "gap-12",
  32: "gap-16",
};

/**
 * Resolves a gap onto the utility scale.
 *
 * `number` is read as scale units (`4` → `gap-4` = 8px), matching the utility
 * names. A `px` string is read as pixels and converted, so the ~90 existing
 * `gap="8px"` callers keep their exact rendering while the inline style goes away.
 */
export function gapUtility(gap: number | string): string | null {
  if (typeof gap === "number") return GAP_SCALE[gap] ?? null;
  const trimmed = gap.trim();
  const px = trimmed.endsWith("px") ? Number.parseFloat(trimmed) : Number.NaN;
  if (Number.isFinite(px)) return GAP_SCALE[px] ?? null;
  return null;
}

/**
 * The gap utility for a primitive, or `null` when the value is off-scale and the
 * caller must supply its own `gapRaw`. Keeps the fallback decision in one place
 * so no primitive invents its own arbitrary utility.
 */
export function resolveGap(gap: number | string | undefined, fallback: number): string | null {
  const resolved = gap === undefined ? GAP_SCALE[fallback] ?? null : gapUtility(gap);
  return resolved;
}
