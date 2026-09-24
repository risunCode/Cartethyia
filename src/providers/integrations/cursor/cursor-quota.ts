import type { FetchLike, ProviderQuotaResult } from "../../quota/quota-contracts";
import { getJson, percentWindow, record, text, isoDate } from "../../quota/quota-contracts";
import { providerBaseUrl } from "../../provider-metadata";
import { extractCursorAccessTokenUserId, parseCursorCredential } from "./cursor-oauth";

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value)))
    return Number(value);
  return undefined;
}

function parseCursorCentsBucket(
  bucket: Record<string, unknown>,
): { used: number; limit?: number; remaining?: number; usedFraction?: number } | null {
  if (bucket.enabled === false) return null;
  const used = toNumber(bucket.used);
  const remaining = toNumber(bucket.remaining);
  const limit = toNumber(bucket.limit);
  if (limit !== undefined && limit > 0) {
    let usedVal: number | undefined;
    if (used !== undefined && used > 0) usedVal = used;
    else if (remaining !== undefined && remaining < limit) usedVal = Math.max(0, limit - remaining);
    else if (used !== undefined) usedVal = used;
    else return null;
    const rem = Math.max(0, limit - usedVal);
    return {
      used: usedVal / 100,
      limit: limit / 100,
      remaining: rem / 100,
      usedFraction: usedVal / limit,
    };
  }
  if (used !== undefined && used >= 0)
    return {
      used: used / 100,
      ...(limit !== undefined ? { limit: limit / 100 } : {}),
      ...(limit ? { usedFraction: used / limit } : {}),
    };
  return null;
}

function parseCursorUsage(body: unknown): ProviderQuotaResult {
  const root = record(body) ?? {};
  // Handle both direct and data-wrapped responses
  const payload = record(root.data) ?? root;
  // Try to parse as individualUsage (from /api/usage-summary)
  const individual = record(payload.individualUsage) ?? record(root.individualUsage);
  if (individual) {
    const plan = record(individual.plan) ?? record(individual.overall);
    const overall = record(individual.overall);
    const target = plan ?? overall;
    if (target) {
      const autoPct = toNumber(target.autoPercentUsed);
      const apiPct = toNumber(target.apiPercentUsed);
      const totalPct = toNumber(target.totalPercentUsed);
      const pct = autoPct ?? apiPct ?? totalPct;
      // Zero overall usage carries no quota signal — don't parse it into a
      // row (it renders as a misleading "100%").
      if (pct !== undefined && pct > 0) {
        return {
          source: "cursor",
          plan: text(target.plan) ?? text(payload.plan) ?? "Cursor",
          windows: [
            percentWindow(
              "quota",
              "Cursor Models",
              pct,
              isoDate(payload.billingCycleEnd ?? payload.resetsAt ?? payload.startOfMonth),
            ),
          ],
          error: null,
        };
      }
      const bucket = parseCursorCentsBucket(target);
      if (bucket?.usedFraction !== undefined) {
        return {
          source: "cursor",
          plan: text(target.plan) ?? "Cursor",
          windows: [
            percentWindow(
              "quota",
              "Cursor Models",
              bucket.usedFraction * 100,
              isoDate(payload.billingCycleEnd ?? payload.startOfMonth),
            ),
          ],
          error: null,
        };
      }
    }
    // Try onDemand
    const onDemand = record(individual.onDemand);
    if (onDemand) {
      const bucket = parseCursorCentsBucket(onDemand);
      if (bucket?.usedFraction !== undefined) {
        return {
          source: "cursor",
          plan: "Cursor",
          windows: [
            percentWindow(
              "quota",
              "On-Demand",
              bucket.usedFraction * 100,
              isoDate(payload.billingCycleEnd),
            ),
          ],
          error: null,
        };
      }
    }
  }
  // Direct usage fields and bucketed usage fields are both supported by the
  // provider contract; normalize either shape into one quota result.
  const buckets: Array<{ key: string; used: number; limit?: number }> = [];
  for (const [key, value] of Object.entries(payload)) {
    if (!record(value)) continue;
    const rec = record(value)!;
    const used =
      toNumber(rec.numRequests) ??
      toNumber(rec.used) ??
      toNumber(rec.amountUsed) ??
      toNumber(rec.usdUsed);
    const limit =
      toNumber(rec.maxRequestUsage) ??
      toNumber(rec.limit) ??
      toNumber(rec.amountLimit) ??
      toNumber(rec.usdLimit);
    if (used === undefined) continue;
    // Buckets without consumption carry no quota signal — don't parse them
    // into windows (a zero-used bucket renders as a misleading "100%").
    // A percent also needs a positive limit; without one any number shown
    // would be fabricated.
    if (used <= 0 || limit === undefined || limit <= 0) continue;
    buckets.push({ key, used, limit });
  }
  if (buckets.length > 0) {
    const windows = buckets.map((b) => {
      const pct = b.limit !== undefined && b.limit > 0 ? (b.used! / b.limit) * 100 : 0;
      return percentWindow(
        `cursor:${b.key}`,
        `${b.key}`,
        pct,
        isoDate(payload.billingCycleEnd ?? payload.startOfMonth ?? payload.resetsAt),
        b.used,
        b.limit,
      );
    });
    return { source: "cursor", plan: "Cursor", windows, error: null };
  }
  // Fallback to single used/limit
  const used =
    toNumber(payload.used) ??
    toNumber(record(payload.usage)?.used) ??
    toNumber(payload.numRequests);
  const limit =
    toNumber(payload.limit) ??
    toNumber(record(payload.usage)?.limit) ??
    toNumber(payload.maxRequestUsage);
  const remaining = toNumber(payload.remaining);
  let usedFraction: number | undefined;
  if (used !== undefined && limit !== undefined && limit > 0) usedFraction = used / limit;
  else if (remaining !== undefined && limit !== undefined && limit > 0)
    usedFraction = (limit - remaining) / limit;
  else if (typeof payload.percentUsed === "number")
    usedFraction = (payload.percentUsed as number) / 100;
  else if (typeof payload.totalPercentUsed === "number")
    usedFraction = (payload.totalPercentUsed as number) / 100;
  // Zero-usage windows carry no quota signal — don't parse them into rows
  // (they render as a misleading "100%"). Unknown shapes fall through.
  if (usedFraction !== undefined && usedFraction > 0) {
    const pct = Math.min(100, Math.max(0, usedFraction * 100));
    return {
      source: "cursor",
      plan: text(payload.plan) ?? text(payload.tier) ?? "Cursor",
      windows: [
        percentWindow(
          "quota",
          "Quota",
          pct,
          isoDate(payload.billingCycleEnd ?? payload.resetsAt ?? payload.startOfMonth),
        ),
      ],
      error: null,
    };
  }
  // Try windows array
  const windows = Array.isArray(payload.windows) ? payload.windows : [];
  if (windows.length > 0) {
    const parsed = windows.flatMap((w) => {
      const rec = record(w);
      if (!rec) return [];
      const p = toNumber(rec.percentUsed) ?? toNumber(rec.usedPercent);
      if (p === undefined || p <= 0) return [];
      return [
        percentWindow(
          String(rec.kind ?? "quota"),
          String(rec.label ?? "Quota"),
          p,
          isoDate(rec.resetsAt),
        ),
      ];
    });
    if (parsed.length > 0)
      return {
        source: "cursor",
        plan: text(payload.plan) ?? "Cursor",
        windows: parsed,
        error: null,
      };
  }
  return { source: "cursor", plan: text(payload.plan) ?? "Cursor", windows: [], error: null };
}

function parseCursorUsageSummary(body: unknown): ProviderQuotaResult {
  const root = record(body) ?? {};
  const payload = record(root.data) ?? root;
  const individual = record(payload.individualUsage);
  const plan = individual ? record(individual.plan) : null;
  if (!plan)
    return { source: "cursor", plan: text(payload.plan) ?? "Cursor", windows: [], error: null };
  const resetsAt = isoDate(
    payload.billingCycleEnd ?? payload.endOfMonth ?? payload.resetsAt ?? payload.nextReset,
  );
  const rails: readonly [string, string, number | null][] = [
    ["cursor-models", "Cursor Models", toNumber(plan.autoPercentUsed) ?? null],
    ["other-models", "Other Models", toNumber(plan.apiPercentUsed) ?? null],
  ];
  const windows = rails.flatMap(([kind, label, value]) =>
    value === null ? [] : [percentWindow(kind, label, value, resetsAt)],
  );
  return {
    source: "cursor",
    plan: text(plan.plan) ?? text(payload.plan) ?? "Cursor",
    windows,
    error: null,
  };
}

export async function fetchCursorQuota(
  credential: string,
  fetcher: FetchLike,
): Promise<ProviderQuotaResult> {
  const parsed = parseCursorCredential(credential);
  const token = parsed.accessToken || credential.trim();
  if (!token) throw new Error("Cursor credential is empty.");
  const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
  const base = providerBaseUrl("cursor");
  const endpoints = [`${base}/auth/usage`, `${base}/api/usage`];
  const reports: ProviderQuotaResult[] = [];
  let lastError: unknown = null;
  // Any 200-shape response — even one with zero usable windows — proves the
  // quota endpoints are reachable. Only a total fetch failure is an error;
  // healthy-but-unused accounts render the neutral empty state instead.
  let fetchedOk = false;
  for (const url of endpoints) {
    try {
      const body = await getJson(url, headers, fetcher);
      fetchedOk = true;
      const parsed = parseCursorUsage(body);
      if (parsed.windows.length > 0) reports.push(parsed);
      lastError = parsed.error;
    } catch (error) {
      lastError = error;
    }
  }
  const userId = parsed.userId ?? extractCursorAccessTokenUserId(token);
  if (userId) {
    try {
      const body = await getJson(
        "https://cursor.com/api/usage-summary",
        {
          accept: "application/json",
          Cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${token}`)}`,
        },
        fetcher,
      );
      const parsed = parseCursorUsageSummary(body);
      if (parsed.windows.length > 0) reports.push(parsed);
      lastError = parsed.error;
    } catch (error) {
      lastError = error;
    }
  }
  if (reports.length > 0) {
    return {
      source: "cursor",
      plan: reports.find((report) => report.plan !== null)?.plan ?? "Cursor",
      windows: reports.flatMap((report) => report.windows),
      error: null,
    };
  }
  if (fetchedOk) return { source: "cursor", plan: "Cursor", windows: [], error: null };
  const message = lastError instanceof Error ? lastError.message : String(lastError ?? "");
  return {
    source: "cursor",
    plan: null,
    windows: [],
    error: message || "No Cursor quota data returned.",
  };
}
