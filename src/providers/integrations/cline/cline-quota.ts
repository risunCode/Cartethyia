import type { FetchLike, ProviderQuotaResult, ProviderQuotaWindow } from "../../quota/quota-contracts";
import { authCredential, getJson, percentWindow, record, text, number, isoDate } from "../../quota/quota-contracts";
import { probeApiKeyConnectivity } from "../../quota/quota-support";
import { getClineClientVersion, refreshClineClientVersion } from "../../operations/client-versions";

/** Quota headers always carry the currently resolved CLI version. */
function clineQuotaHeaders(): Record<string, string> {
  refreshClineClientVersion();
  const version = getClineClientVersion();
  return {
    accept: "application/json",
    "content-type": "application/json",
    "user-agent": `Cline/${version}`,
    "x-platform": "server",
    "x-platform-version": "1.0.0",
    "x-client-type": "cline-cli",
    "x-client-version": version,
    "x-core-version": version,
    "x-is-multiroot": "false",
  };
}

function usageWindows(value: unknown): ProviderQuotaWindow[] {
  const payload = record(value);
  const limits = Array.isArray(payload?.limits) ? payload.limits : [];
  return limits.flatMap((raw, index) => {
    const limit = record(raw);
    if (!limit) return [];
    const kind = text(limit.type) ?? `window-${index + 1}`;
    const label =
      kind === "five_hour"
        ? "5 Hour"
        : kind === "weekly"
          ? "7 Day"
          : kind === "monthly"
            ? "30 Day"
            : kind;
    const used = number(limit.percentUsed);
    const limitValue = number(limit.limit) ?? number(limit.entitlement) ?? number(limit.total);
    const usedValue =
      number(limit.used) ??
      number(limit.usedCredits) ??
      (used !== null && limitValue !== null ? (limitValue * used) / 100 : null);
    const resetsAt = isoDate(limit.resetsAt);
    return used === null && resetsAt === null
      ? []
      : [percentWindow(kind, label, used, resetsAt, usedValue, limitValue)];
  });
}

function isMissingPlanHistory(reason: unknown): boolean {
  const message =
    reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "";
  return /\b404\b|\bno plan history\b/i.test(message);
}

const CLINE_PROVIDER_ID = "cline" as const;
const CLINE_API_KEY_PREFIX = "cline-api-key:" as const;

/** Wraps a resolved api_key secret so the collector can route it to /models. */
export function markClineApiKeyCredential(credential: string): string {
  return credential.startsWith(CLINE_API_KEY_PREFIX) ? credential : `${CLINE_API_KEY_PREFIX}${credential}`;
}

export async function fetchClineQuota(
  credential: string,
  fetcher: FetchLike,
): Promise<ProviderQuotaResult> {
  // API-key accounts carry no OAuth envelope and upstream exposes no quota
  // surface for them, so an api key must never reach the OAuth-only
  // users/me endpoint (a 401 there is not dispatchable either). The account
  // test for keys is plain validity via /models.
  if (credential.startsWith(CLINE_API_KEY_PREFIX)) {
    return probeApiKeyConnectivity(
      CLINE_PROVIDER_ID,
      credential.slice(CLINE_API_KEY_PREFIX.length),
      fetcher,
    );
  }
  const fields = authCredential(credential);
  const access = text(fields.accessToken);
  if (!access) throw new Error("Cline credential has no access token.");
  const headers = {
    ...clineQuotaHeaders(),
    authorization: `Bearer ${access.startsWith("workos:") ? access : `workos:${access}`}`,
  };
  const me = record(await getJson("https://api.cline.bot/api/v1/users/me", headers, fetcher));
  const userId = text(me?.id);
  if (!userId) throw new Error("Cline account response has no user id.");
  const [planRaw, limitsRaw] = await Promise.allSettled([
    getJson("https://api.cline.bot/api/v1/users/me/plan", headers, fetcher),
    getJson("https://api.cline.bot/api/v1/users/me/plan/usage-limits", headers, fetcher),
  ]);
  const plan = record(planRaw.status === "fulfilled" ? planRaw.value : null);
  const limitsFailed = limitsRaw.status === "rejected";
  const windows = usageWindows(limitsRaw.status === "fulfilled" ? limitsRaw.value : null);
  const error =
    limitsFailed && !isMissingPlanHistory(limitsRaw.reason)
      ? "Failed to fetch quota limits."
      : null;
  return {
    source: "cline",
    plan: text(record(plan?.plan)?.displayName) ?? text(plan?.displayName) ?? "Cline",
    windows,
    error,
  };
}
