/**
 * Shared reader for providers that report quota as an array of limit objects.
 *
 * Claude (`limits[]` with per-model scopes) and Cline (`limits[]` keyed by
 * window type) both answer usage as an array of objects carrying a kind, a
 * percentage, and a reset — so the array walk, the "must have something to
 * report" guard, and the fallback label all live here once. What differs per
 * provider is only which field names carry those three values and how a kind
 * maps to a display label, which is why both stay parameters.
 */
import type { ProviderQuotaWindow } from "./quota-contracts";
import { isoDate, number, percentWindow, record, text } from "./quota-contracts";

/** Where one provider's limit entries and their fields live. */
export interface LimitWindowShape {
  /** Path to the array of limit objects inside the payload. Defaults to `limits`. */
  readonly arrayPath?: string;
  /** Ordered field names read for the window kind. */
  readonly kindPaths: readonly string[];
  /** Ordered field names read for the used percentage. */
  readonly percentPaths: readonly string[];
  /** Ordered field names read for the reset timestamp. */
  readonly resetPaths: readonly string[];
  /** Ordered field names read for the absolute limit. */
  readonly limitPaths?: readonly string[];
  /** Ordered field names read for the absolute used value. */
  readonly usedPaths?: readonly string[];
  /**
   * Maps a kind to its display label. Called only for kinds the map does not
   * name, so `null` means "use the caller's fallback" — a kind is never
   * dropped for having no pretty label.
   */
  readonly labelFor?: ((kind: string, entry: Record<string, unknown>) => string | null) | undefined;
  /** Label used when `labelFor` returns `null`. Defaults to the humanized kind. */
  readonly fallbackLabel?: ((kind: string) => string) | undefined;
  /**
   * Derives the absolute used value when the payload carries only a percentage
   * and a limit. Returning `null` falls through to `usedPaths`. Cline needs
   * this: it reports `limit` and `percentUsed` but no absolute `used`.
   */
  readonly deriveUsed?:
    | ((entry: Record<string, unknown>, usedPercent: number | null, limit: number | null) => number | null)
    | undefined;
}

function readFirst(entry: Record<string, unknown>, paths: readonly string[]): unknown {
  for (const path of paths) {
    const value = entry[path];
    if (value !== undefined) return value;
  }
  return undefined;
}

function humanize(kind: string): string {
  return kind.replace(/_/g, " ");
}

/**
 * Reads one provider's limit array into quota windows.
 *
 * An entry carrying neither a percentage nor a reset is skipped: it has
 * nothing to render, and a zero there would read as "0% used" when the truth
 * is "the upstream said nothing".
 */
export function parseLimitWindows(
  payload: unknown,
  shape: LimitWindowShape,
): readonly ProviderQuotaWindow[] {
  const root = record(payload);
  if (root === null) return [];
  const raw = root[shape.arrayPath ?? "limits"];
  if (!Array.isArray(raw)) return [];
  const windows: ProviderQuotaWindow[] = [];
  for (const [index, entry] of raw.entries()) {
    const limit = record(entry);
    if (limit === null) continue;
    const kind = text(readFirst(limit, shape.kindPaths)) ?? `window-${index + 1}`;
    const percent = number(readFirst(limit, shape.percentPaths));
    const reset = isoDate(readFirst(limit, shape.resetPaths));
    if (percent === null && reset === null) continue;
    const limitValue = shape.limitPaths
      ? number(readFirst(limit, shape.limitPaths))
      : null;
    const usedValue =
      (shape.usedPaths ? number(readFirst(limit, shape.usedPaths)) : null) ??
      shape.deriveUsed?.(limit, percent, limitValue) ??
      null;
    const label =
      shape.labelFor?.(kind, limit) ?? shape.fallbackLabel?.(kind) ?? humanize(kind);
    windows.push(percentWindow(kind, label, percent, reset, usedValue, limitValue, "independent"));
  }
  return windows;
}
