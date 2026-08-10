import type { FetchLike, ProviderQuotaResult, ProviderQuotaWindow } from "./types";
import { authCredential, getJson, isoDate, number, percentWindow, record, text } from "./shared";

const CLINE_QUOTA_HEADERS = {
  accept: "application/json",
  "content-type": "application/json",
  "user-agent": "Cline/4.0.11",
  "x-platform": "server",
  "x-platform-version": "1.0.0",
  "x-client-type": "cline-cli",
  "x-client-version": "4.0.11",
  "x-core-version": "4.0.11",
  "x-is-multiroot": "false",
} as const;

function usageWindows(value: unknown): ProviderQuotaWindow[] {
  const payload = record(value);
  const limits = Array.isArray(payload?.limits) ? payload.limits : [];
  return limits.flatMap((raw, index) => {
    const limit = record(raw);
    if (!limit) return [];
    const kind = text(limit.type) ?? `window-${index + 1}`;
    const label = kind === "five_hour" ? "5 Hour" : kind === "weekly" ? "7 Day" : kind === "monthly" ? "30 Day" : kind;
    const used = number(limit.percentUsed);
    const resetsAt = isoDate(limit.resetsAt);
    return used === null && resetsAt === null ? [] : [percentWindow(kind, label, used, resetsAt)];
  });
}

export async function fetchClineQuota(credential: string, fetcher: FetchLike): Promise<ProviderQuotaResult> {
  const fields = authCredential(credential);
  const access = text(fields.accessToken);
  if (!access) throw new Error("Cline credential has no access token.");
  const headers = { ...CLINE_QUOTA_HEADERS, authorization: `Bearer ${access.startsWith("workos:") ? access : `workos:${access}`}` };
  const me = record(await getJson("https://api.cline.bot/api/v1/users/me", headers, fetcher));
  const userId = text(me?.id);
  if (!userId) throw new Error("Cline account response has no user id.");
  const [planRaw, limitsRaw] = await Promise.allSettled([
    getJson("https://api.cline.bot/api/v1/users/me/plan", headers, fetcher),
    getJson("https://api.cline.bot/api/v1/users/me/plan/usage-limits", headers, fetcher),
  ]);
  const plan = record(planRaw.status === "fulfilled" ? planRaw.value : null);
  const windows = usageWindows(limitsRaw.status === "fulfilled" ? limitsRaw.value : null);
  const error = limitsRaw.status === "rejected" ? "Failed to fetch quota limits." : windows.length === 0 ? "Cline quota response contained no usage limits." : null;
  return { source: "cline", plan: text(record(plan?.plan)?.displayName) ?? text(plan?.displayName) ?? "Cline", windows, error };
}
