/**
 * Generic quota parser for providers whose responses are simple object trees
 * of percentage/usage windows.
 *
 * Providers with genuinely bespoke shapes (Tencent billing envelopes, WorkOS
 * usage arrays, duration-derived labels) keep their own parser; this module
 * only covers the declarative cases so the window-assembly boilerplate lives
 * in one place.
 */
import {
  isoDate,
  number,
  percentWindow,
  quotaRecord,
  text,
} from "./quota-contracts";
import type { ProviderQuotaResult, ProviderQuotaWindow } from "./quota-contracts";

/** How to locate a single value inside a nested object. */
export type ValuePath = readonly string[];

/** Mapping from a response shape to a provider quota window. */
export interface QuotaWindowMapping {
  readonly kind: string;
  readonly label: string;
  /** Paths (in priority order) for the used-percent value. */
  readonly usedPercentPaths?: readonly ValuePath[];
  /** Paths (in priority order) for the remaining-percent value. */
  readonly remainingPercentPaths?: readonly ValuePath[];
  /** Paths (in priority order) for the reset timestamp. */
  readonly resetPaths?: readonly ValuePath[];
  /** Fixed fallback reset timestamp. */
  readonly resetFallback?: string;
  /** Paths (in priority order) for the absolute used value. */
  readonly usedPaths?: readonly ValuePath[];
  /** Paths (in priority order) for the absolute limit value. */
  readonly limitPaths?: readonly ValuePath[];
  /** Multiplier applied to the final percentage (e.g., 100 for a 0-1 ratio). */
  readonly valueMultiplier?: number;
  /**
   * Provider-specific percentage derivation evaluated before the declarative
   * paths. Return `null` to fall through to the paths.
   */
  readonly derivePercent?: (payload: unknown) => number | null;
  /**
   * When true, a window is still emitted with a `null` percentage if a reset
   * timestamp is present (used for countdown-only windows).
   */
  readonly emitWithoutPercent?: boolean;
}

/** Options for the generic quota parser. */
export interface QuotaParserOptions {
  readonly source: string;
  /** Where to read the plan name from the payload. */
  readonly planPaths?: readonly ValuePath[];
  readonly planFallback?: string;
  /** Custom transform applied to the raw payload before parsing. */
  readonly transform?: (body: unknown) => unknown;
  /** Extra provider-specific windows appended after the declarative ones. */
  readonly extraWindows?: (payload: unknown) => readonly ProviderQuotaWindow[];
}

function readAt(root: unknown, path: ValuePath): unknown | undefined {
  let current: unknown = root;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function findNumber(root: unknown, paths: readonly ValuePath[] | undefined): number | null {
  if (!paths) return null;
  for (const path of paths) {
    const parsed = number(readAt(root, path));
    if (parsed !== null) return parsed;
  }
  return null;
}

function findText(root: unknown, paths: readonly ValuePath[] | undefined): string | null {
  if (!paths) return null;
  for (const path of paths) {
    const parsed = text(readAt(root, path));
    if (parsed !== null) return parsed;
  }
  return null;
}

function findReset(root: unknown, mapping: QuotaWindowMapping): string | null {
  if (mapping.resetPaths) {
    for (const path of mapping.resetPaths) {
      const parsed = isoDate(readAt(root, path));
      if (parsed !== null) return parsed;
    }
  }
  return mapping.resetFallback ?? null;
}

/** Parses a generic quota payload using the provided window mappings. */
export function parseQuotaWindows(
  body: unknown,
  windowMappings: readonly QuotaWindowMapping[],
  options: QuotaParserOptions,
): ProviderQuotaResult {
  const payload = options.transform ? options.transform(body) : quotaRecord(body);
  const windows: ProviderQuotaWindow[] = [];

  for (const mapping of windowMappings) {
    const used = findNumber(payload, mapping.usedPaths);
    const limit = findNumber(payload, mapping.limitPaths);

    let percent: number | null = mapping.derivePercent ? mapping.derivePercent(payload) : null;
    if (percent === null) {
      const usedPercent = findNumber(payload, mapping.usedPercentPaths);
      const remainingPercent = findNumber(payload, mapping.remainingPercentPaths);
      if (usedPercent !== null) {
        percent = usedPercent;
      } else if (remainingPercent !== null) {
        percent = Math.max(0, 100 - remainingPercent);
      } else if (used !== null && limit !== null && limit > 0) {
        percent = (used / limit) * 100;
      }
    }
    if (percent !== null && mapping.valueMultiplier !== undefined && mapping.valueMultiplier !== 0) {
      percent = Math.min(100, Math.max(0, percent * mapping.valueMultiplier));
    }

    const reset = findReset(payload, mapping);
    if (percent === null && !(mapping.emitWithoutPercent === true && reset !== null)) continue;

    windows.push(percentWindow(mapping.kind, mapping.label, percent, reset, used, limit));
  }

  if (options.extraWindows) windows.push(...options.extraWindows(payload));

  return {
    source: options.source,
    plan: findText(payload, options.planPaths) ?? options.planFallback ?? null,
    windows,
    error: null,
  };
}
