/**
 * Cursor quota collector.
 *
 * Cursor publishes two usage surfaces and neither is the inference host:
 *
 *  - `GET https://cursor.com/api/usage-summary`, authenticated with the
 *    `WorkosCursorSessionToken` cookie (`<user id>::<access token>`, the user
 *    id being the part of the access token's `sub` after the `|`). This is the
 *    dashboard the account holder sees, and current Pro / Pro+ / Ultra plans
 *    report their included allowance here as `individualUsage.plan`.
 *  - `GET https://api2.cursor.sh/auth/usage`, a plain bearer call. This is the
 *    older per-model request counter. Current plans answer it with an uncapped,
 *    always-zero bucket, so it is only the fallback for a plan the summary does
 *    not describe.
 *
 * Both are read and merged. A body that matches neither shape yields no
 * windows rather than a fabricated percentage.
 */
import { decodeJwtPayload } from "../../authentication/oauth-flow-store";
import type { FetchLike, ProviderQuotaResult, ProviderQuotaWindow } from "../../quota/quota-contracts";
import { authCredential, getJson, isoDate, number, percentWindow, record, text } from "../../quota/quota-contracts";
import { CURSOR_BASE_URL } from "./cursor-transport";

const USAGE_SUMMARY_URL = "https://cursor.com/api/usage-summary";
const AUTH_USAGE_URL = `${CURSOR_BASE_URL}/auth/usage`;

/** The user id a Cursor access token belongs to, or `null` when it carries none. */
export function cursorUserId(accessToken: string): string | null {
  const sub = text(decodeJwtPayload(accessToken)?.sub);
  if (sub === null) return null;
  const separator = sub.lastIndexOf("|");
  const userId = (separator === -1 ? sub : sub.slice(separator + 1)).trim();
  return userId.length > 0 ? userId : null;
}

/** When the billing cycle ends, read from whichever spelling the payload uses. */
function cycleEnd(payload: Record<string, unknown>): string | null {
  for (const key of ["billingCycleEnd", "endOfMonth", "resetsAt", "nextReset"]) {
    const parsed = isoDate(payload[key]);
    if (parsed !== null) return parsed;
  }
  for (const key of ["startOfMonth", "billingCycleStart", "startOfBillingCycle"]) {
    const parsed = isoDate(payload[key]);
    if (parsed === null) continue;
    const date = new Date(parsed);
    date.setUTCMonth(date.getUTCMonth() + 1);
    return date.toISOString();
  }
  return null;
}

/**
 * One cents bucket (`used` / `limit` / `remaining`, all in USD cents).
 *
 * A disabled bucket and a bucket with no usable number are skipped. An uncapped
 * bucket (no limit) is kept only when it records spend, because a zero uncapped
 * bucket is what current plans answer the legacy endpoint with.
 */
function centsWindow(
  kind: string,
  label: string,
  bucket: Record<string, unknown>,
  resetsAt: string | null,
  keepUncapped: boolean,
): ProviderQuotaWindow | null {
  if (bucket.enabled === false) return null;
  const limitCents = number(bucket.limit);
  const usedCents = number(bucket.used);
  const remainingCents = number(bucket.remaining);
  if (limitCents === null || limitCents <= 0) {
    if (!keepUncapped || usedCents === null || usedCents <= 0) return null;
    return { kind, label, usedPercent: null, remainingPercent: null, resetsAt, used: usedCents / 100, limit: null };
  }
  const used =
    usedCents !== null && usedCents > 0
      ? usedCents
      : remainingCents !== null && remainingCents < limitCents
        ? limitCents - remainingCents
        : usedCents;
  if (used === null) return null;
  return percentWindow(kind, label, (used / limitCents) * 100, resetsAt, used / 100, limitCents / 100);
}

/**
 * The two rails a current plan reports inside `individualUsage.plan`.
 *
 * Cursor's dashboard does not render `used / limit` as the visible percent. It
 * shows `autoPercentUsed` (Cursor's own models, including Composer) and
 * `apiPercentUsed` (every other model) as separate pools. Only a plan that
 * reports neither falls back to the cents total.
 */
function planWindows(bucket: Record<string, unknown>, resetsAt: string | null): readonly ProviderQuotaWindow[] {
  if (bucket.enabled === false) return [];
  const windows: ProviderQuotaWindow[] = [];
  const auto = number(bucket.autoPercentUsed);
  const api = number(bucket.apiPercentUsed);
  const limitCents = number(bucket.limit);
  const limit = limitCents !== null && limitCents > 0 ? limitCents / 100 : null;
  const rounded = (value: number): number => Math.round(value * 10) / 10;
  if (auto !== null) windows.push(percentWindow("cursor-models", "Cursor Models", rounded(auto), resetsAt));
  if (api !== null) {
    windows.push(
      percentWindow("other-models", "Other Models", rounded(api), resetsAt, limit === null ? null : (limit * rounded(api)) / 100, limit),
    );
  }
  if (windows.length > 0) return windows;
  const total = number(bucket.totalPercentUsed);
  if (total !== null) {
    const limitCents = number(bucket.limit);
    const limit = limitCents !== null && limitCents > 0 ? limitCents / 100 : null;
    return [percentWindow("personal", "Personal Usage", total, resetsAt, limit === null ? null : (limit * total) / 100, limit)];
  }
  const fallback = centsWindow("personal", "Personal Usage", bucket, resetsAt, false);
  return fallback === null ? [] : [fallback];
}

/** Windows from `cursor.com/api/usage-summary`, the surface current plans report on. */
export function parseCursorUsageSummary(payload: unknown): readonly ProviderQuotaWindow[] {
  const root = record(payload);
  const individual = record(root?.individualUsage);
  if (root === null || individual === null) return [];
  const resetsAt = cycleEnd(root);
  const windows: ProviderQuotaWindow[] = [];
  const overall = record(individual.overall);
  const overallWindow = overall === null ? null : centsWindow("personal", "Personal Usage", overall, resetsAt, false);
  if (overallWindow !== null) {
    windows.push(overallWindow);
  } else {
    const plan = record(individual.plan);
    if (plan !== null) windows.push(...planWindows(plan, resetsAt));
  }
  const onDemand = record(individual.onDemand);
  const onDemandWindow = onDemand === null ? null : centsWindow("on-demand", "On-Demand Usage", onDemand, resetsAt, false);
  if (onDemandWindow !== null) windows.push(onDemandWindow);
  return windows;
}

/**
 * Windows from the legacy `api2.cursor.sh/auth/usage` counter.
 *
 * Each object-valued field is one model bucket. A bucket with no recorded use
 * and no cap is dropped: that is the always-zero answer current plans give,
 * and showing it would add a row that never moves.
 */
export function parseCursorAuthUsage(payload: unknown): readonly ProviderQuotaWindow[] {
  const root = record(payload);
  if (root === null) return [];
  const resetsAt = cycleEnd(root);
  const windows: ProviderQuotaWindow[] = [];
  for (const [key, value] of Object.entries(root)) {
    const bucket = record(value);
    if (bucket === null) continue;
    const used =
      number(bucket.numRequests) ?? number(bucket.used) ?? number(bucket.amountUsed) ?? number(bucket.usdUsed);
    if (used === null || used <= 0) continue;
    const limit =
      number(bucket.maxRequestUsage) ?? number(bucket.limit) ?? number(bucket.amountLimit) ?? number(bucket.usdLimit);
    const label = key.charAt(0).toUpperCase() + key.slice(1);
    windows.push(
      limit === null || limit <= 0
        ? { kind: key, label, usedPercent: null, remainingPercent: null, resetsAt, used, limit: null }
        : percentWindow(key, label, (used / limit) * 100, resetsAt, used, limit),
    );
  }
  return windows;
}

/** Reads one usage endpoint, returning `null` when it is unreachable or rejects the token. */
async function readUsage(url: string, headers: Record<string, string>, fetcher: FetchLike): Promise<unknown | null> {
  try {
    return await getJson(url, headers, fetcher);
  } catch {
    return null;
  }
}

export async function fetchCursorQuota(credential: string, fetcher: FetchLike): Promise<ProviderQuotaResult> {
  const access = text(authCredential(credential).accessToken) ?? credential.trim();
  if (access.length === 0) {
    return { source: "cursor", plan: null, windows: [], error: "Cursor account has no access token." };
  }
  const userId = cursorUserId(access);
  const [summary, legacy] = await Promise.all([
    userId === null
      ? Promise.resolve(null)
      : readUsage(
          USAGE_SUMMARY_URL,
          {
            accept: "application/json",
            cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${access}`)}`,
          },
          fetcher,
        ),
    readUsage(AUTH_USAGE_URL, { accept: "application/json", authorization: `Bearer ${access}` }, fetcher),
  ]);
  const windows = [...parseCursorUsageSummary(summary), ...parseCursorAuthUsage(legacy)];
  const plan = text(record(summary)?.membershipType) ?? text(record(summary)?.plan);
  if (windows.length === 0 && summary === null && legacy === null) {
    return { source: "cursor", plan, windows: [], error: "Cursor usage endpoint rejected the request." };
  }
  return { source: "cursor", plan, windows, error: null };
}
