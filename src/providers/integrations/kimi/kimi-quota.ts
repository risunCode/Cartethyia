import type {
  FetchLike,
  ProviderQuotaResult,
  ProviderQuotaWindow,
} from "../../quota/quota-contracts";
import { getJson, isoDate, number, percentWindow, record } from "../../quota/quota-contracts";
import { getKimiCommonHeaders, parseKimiCredential } from "./kimi-oauth";
import { resolveKimiQuotaBaseUrl } from "../../../config";

const SOURCE = "kimi";

interface KimiUsageWindow {
  duration?: unknown;
  timeUnit?: unknown;
  reset_at?: unknown;
  resetAt?: unknown;
  reset_time?: unknown;
  resetTime?: unknown;
  reset_in?: unknown;
  resetIn?: unknown;
  ttl?: unknown;
  window?: unknown;
}

interface KimiUsageRow {
  name?: unknown;
  title?: unknown;
  limit?: unknown;
  used?: unknown;
  remaining?: unknown;
  reset_at?: unknown;
  resetAt?: unknown;
  reset_time?: unknown;
  resetTime?: unknown;
  detail?: unknown;
  window?: unknown;
}

interface KimiUsagePayload {
  usage?: unknown;
  limits?: unknown;
  plan?: unknown;
  tier?: unknown;
}

function parseResetTime(
  row: KimiUsageRow,
  window: KimiUsageWindow | undefined,
): string | null {
  const detail = record(row.detail);
  const values = [
    row.reset_at,
    row.resetAt,
    row.reset_time,
    row.resetTime,
    detail?.reset_at,
    detail?.resetAt,
    detail?.reset_time,
    detail?.resetTime,
    window?.reset_at,
    window?.resetAt,
    window?.reset_time,
    window?.resetTime,
  ];
  for (const value of values) {
    const parsed = isoDate(value);
    if (parsed !== null) return parsed;
  }
  const resetSeconds = [window?.reset_in, window?.resetIn, window?.ttl, window?.window];
  for (const value of resetSeconds) {
    const seconds = number(value);
    if (seconds !== null && seconds >= 0)
      return new Date(Date.now() + seconds * 1000).toISOString();
  }
  return null;
}

function durationMs(window: KimiUsageWindow | undefined): number | null {
  if (!window) return null;
  const duration = number(window.duration);
  const unit = typeof window.timeUnit === "string" ? window.timeUnit.toUpperCase() : "";
  if (duration === null || duration <= 0) return null;
  if (unit.includes("MINUTE")) return duration * 60_000;
  if (unit.includes("HOUR")) return duration * 3_600_000;
  if (unit.includes("DAY")) return duration * 86_400_000;
  if (unit.includes("WEEK")) return duration * 7 * 86_400_000;
  if (unit.includes("SECOND")) return duration * 1_000;
  return null;
}

function durationLabel(window: KimiUsageWindow | undefined, fallback: string): string {
  const duration = number(window?.duration);
  const unit = typeof window?.timeUnit === "string" ? window.timeUnit.toUpperCase() : "";
  if (duration === null || duration <= 0 || !unit) return fallback;
  if (unit.includes("MINUTE")) return `${duration}m limit`;
  if (unit.includes("HOUR")) return `${duration}h limit`;
  if (unit.includes("DAY")) return `${duration}d limit`;
  if (unit.includes("WEEK")) return `${duration}w limit`;
  return `${duration} limit`;
}

function durationId(window: KimiUsageWindow | undefined): string {
  const ms = durationMs(window);
  if (ms === null) return "default";
  if (ms % (7 * 86_400_000) === 0) return `${ms / (7 * 86_400_000)}w`;
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  return `${Math.round(ms / 60_000)}m`;
}

function rowWindow(
  row: KimiUsageRow,
  fallbackLabel: string,
  aggregate: boolean,
): ProviderQuotaWindow | undefined {
  const detail = record(row.detail) ?? row;
  const window = record(row.window) ?? undefined;
  const limit = number(detail.limit);
  const remaining = number(detail.remaining);
  const used = number(detail.used) ?? (remaining !== null && limit !== null ? limit - remaining : null);
  if (used === null && limit === null) return undefined;
  const usedPercent =
    used !== null && limit !== null && limit > 0
      ? (used / limit) * 100
      : remaining !== null && remaining >= 0 && remaining <= 1
        ? (1 - remaining) * 100
        : null;
  if (usedPercent === null) return undefined;
  const id = aggregate ? "7d" : durationId(window);
  const label = aggregate ? "7 Day" : durationLabel(window, fallbackLabel);
  return percentWindow(id, label, usedPercent, parseResetTime(row, window), used, limit);
}

function parseWindows(payload: KimiUsagePayload): readonly ProviderQuotaWindow[] {
  const windows: ProviderQuotaWindow[] = [];
  const aggregate = record(payload.usage);
  if (aggregate) {
    const parsed = rowWindow(aggregate as KimiUsageRow, "Total quota", true);
    if (parsed) windows.push(parsed);
  }
  if (Array.isArray(payload.limits)) {
    payload.limits.forEach((item, index) => {
      const row = record(item);
      if (!row) return;
      const window = record(row.window) ?? undefined;
      const label =
        (typeof row.name === "string" && row.name) ||
        (typeof row.title === "string" && row.title) ||
        durationLabel(window, `Limit #${index + 1}`);
      const parsed = rowWindow(row as KimiUsageRow, label, false);
      if (parsed && !windows.some((existing) => existing.kind === parsed.kind)) windows.push(parsed);
    });
  }
  return windows;
}

function kimiBaseUrl(): string {
  // Through CONFIG_SPEC, so the value is documented and the default cannot
  // drift from what the bundled provider metadata advertises.
  return resolveKimiQuotaBaseUrl().replace(/\/+$/, "");
}

/** Fetches Kimi Code's subscription windows from `/coding/v1/usages`. */
export async function fetchKimiQuota(
  credential: string,
  fetcher: FetchLike,
  source = SOURCE,
): Promise<ProviderQuotaResult> {
  const parsed = parseKimiCredential(credential);
  const payload = (await getJson(
    `${kimiBaseUrl()}/usages`,
    {
      ...getKimiCommonHeaders(parsed.deviceId),
      authorization: `Bearer ${parsed.accessToken}`,
    },
    fetcher,
  )) as KimiUsagePayload;
  const windows = parseWindows(payload);
  const plan =
    (typeof payload.plan === "string" && payload.plan.trim()) ||
    (typeof payload.tier === "string" && payload.tier.trim()) ||
    "Kimi";
  return { source, plan, windows, error: null };
}
