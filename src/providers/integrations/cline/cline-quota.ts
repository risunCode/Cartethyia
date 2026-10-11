import type { FetchLike, ProviderQuotaResult, ProviderQuotaWindow } from "../../quota/quota-contracts";
import { authCredential, getJson, record, text } from "../../quota/quota-contracts";
import { parseLimitWindows } from "../../quota/quota-limit-windows";
import { probeApiKeyConnectivity } from "../../quota/quota-support";
import { getClineClientVersion, getClineSdkVersion } from "../../operations/client-versions";
import { clinePlatform, clinePlatformVersion } from "../../operations/cli-platform";

/**
 * Quota headers always carry the currently resolved CLI version.
 *
 * The two version headers are two different versions and must stay that way.
 * `x-client-version` is the Cline client the operator is running, from the
 * shared pooler. `x-core-version` is the `@cline/sdk` version, which is a
 * separate npm package with its own release line — this used to send the
 * *client* version in both slots, so the billing surface was told our core was
 * `4.1.23`, a vscode client version that `@cline/sdk` never published.
 *
 * `src/providers/integrations/cline/cline.ts` has always sent the correct
 * pairing (`clientVersion` / `sdkVersion`) on the dispatch path, and that is
 * the identity proven to work against this provider. A header the upstream can
 * validate is not cosmetic: an implausible core version is exactly what a
 * "please update and re-authenticate" refusal is shaped like, and it is
 * indistinguishable from a dead credential from the response alone.
 *
 * `x-client-type` stays `cline-cli`: the billing surface is read by the CLI,
 * while `cline.ts` correctly claims `cline-sdk` for the chat surface it talks
 * to. Not verified against a live billing response — see the roadmap note.
 */
function clineQuotaHeaders(): Record<string, string> {
  const version = getClineClientVersion();
  return {
    accept: "application/json",
    "content-type": "application/json",
    "user-agent": `Cline/${version}`,
    "x-platform": clinePlatform(),
    "x-platform-version": clinePlatformVersion(),
    "x-client-type": "cline-cli",
    "x-client-version": version,
    "x-core-version": getClineSdkVersion(),
    "x-is-multiroot": "false",
  };
}

const CLINE_WINDOW_LABELS: Readonly<Record<string, string>> = {
  five_hour: "5 Hour",
  weekly: "7 Day",
  monthly: "30 Day",
};

/** Reads Cline's `limits[]` array — one entry per billing window. */
function usageWindows(value: unknown): readonly ProviderQuotaWindow[] {
  return [
    ...parseLimitWindows(value, {
      kindPaths: ["type"],
      percentPaths: ["percentUsed"],
      resetPaths: ["resetsAt"],
      limitPaths: ["limit", "entitlement", "total"],
      usedPaths: ["used", "usedCredits"],
      // Cline reports a percentage and a ceiling but no absolute used value,
      // so the absolute is derived rather than left null.
      deriveUsed: (_entry, usedPercent, limit) =>
        usedPercent !== null && limit !== null ? (limit * usedPercent) / 100 : null,
      labelFor: (kind) => CLINE_WINDOW_LABELS[kind] ?? null,
      fallbackLabel: (kind) => kind,
    }),
  ];
}

function isMissingPlanHistory(reason: unknown): boolean {
  const message =
    reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "";
  return /\b404\b|\bno plan history\b/i.test(message);
}

const CLINE_PROVIDER_ID = "cline" as const;
/** Envelope marking a resolved secret as an api key rather than an OAuth grant. */
export const CLINE_API_KEY_PREFIX = "cline-api-key:" as const;

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
