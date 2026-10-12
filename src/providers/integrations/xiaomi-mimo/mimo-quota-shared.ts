/**
 * Shared MiMo quota window parsing.
 *
 * Desktop and Studio answer the same usage envelope — `data.percent` is
 * *remaining*, and the reset is either a `resetAt` epoch-seconds number or a
 * `resetDate` string — so the reading lives here once instead of twice. The
 * two collectors differ only in the `source` / `plan` strings they stamp.
 */
import type { ProviderQuotaResult, ProviderQuotaWindow } from "../../quota/quota-contracts";
import { number, percentWindow, record } from "../../quota/quota-contracts";

/** Reads the reset timestamp, preferring the epoch form over the date string. */
function mimoReset(data: Record<string, unknown>): string | null {
  const epochSeconds = number(data["resetAt"]);
  if (epochSeconds !== null && Number.isFinite(epochSeconds)) {
    return new Date(epochSeconds * 1000).toISOString();
  }
  const raw = data["resetDate"];
  return typeof raw === "string" && Number.isFinite(Date.parse(raw))
    ? new Date(raw).toISOString()
    : null;
}

/**
 * Parses one MiMo usage payload into its single weekly window.
 *
 * A payload carrying neither a percentage nor a reset yields an empty window
 * list rather than a fabricated zero: an unknown shape must read as "no data",
 * not "0% used".
 */
export function parseMimoUsageWindows(
  payload: unknown,
  options: { readonly source: string; readonly plan: string },
): ProviderQuotaResult {
  const data = record(record(payload)?.["data"]);
  if (data === null) {
    return {
      source: options.source,
      plan: options.plan,
      windows: [],
      error: `Unexpected response format from ${options.plan} usage endpoint`,
    };
  }
  // Upstream reports remaining percent, e.g. 99.9% remaining.
  const remaining = number(data["percent"]);
  const usedPercent = remaining === null ? null : Math.max(0, Math.min(100, 100 - remaining));
  const resetIso = mimoReset(data);
  const windows: ProviderQuotaWindow[] = [];
  if (usedPercent !== null || resetIso !== null) {
    windows.push(
      percentWindow(
        "weekly",
        "Weekly Quota",
        usedPercent === null ? null : Math.round(usedPercent * 10) / 10,
        resetIso,
        null,
        null,
        "independent",
      ),
    );
  }
  return { source: options.source, plan: options.plan, windows, error: null };
}
