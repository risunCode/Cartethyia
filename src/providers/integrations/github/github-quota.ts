/**
 * GitHub Copilot quota collector.
 *
 * Copilot publishes no usage endpoint of its own; the account's plan and quota
 * windows are read from the same `/copilot_internal/v2/token` call that mints
 * the inference token. That endpoint takes the long-lived GitHub OAuth token,
 * not the minted Copilot token, which is why the credential envelope carries
 * the GitHub token (`github`) alongside the minted one — the collector is
 * handed only the access value, so the GitHub token has to travel in it.
 *
 * The response shape is not a documented contract, so every field is read
 * defensively and an unrecognized body yields an empty window list rather than
 * a fabricated percentage.
 */
import type { FetchLike, ProviderQuotaResult, ProviderQuotaWindow } from "../../quota/quota-contracts";
import { getJson, isoDate, number, percentWindow, quotaRecord, text } from "../../quota/quota-contracts";
import { resolveGithubEnterpriseDomain } from "../../../config/providers";
import { GITHUB_REQUEST_HEADERS, parseGithubCredential } from "./github-oauth";

/**
 * Reads the quota windows out of a Copilot token response.
 *
 * The fields are intentionally permissive: `limited_user_quotas` and
 * `monthly_quotas` are the two spellings the endpoint has used, each keyed by
 * window name (`chat`, `completions`), and the reset is either an ISO date or
 * a plain date string. A window is emitted only when it carries a usable
 * number, so a body with none of these yields no windows.
 */
export function parseGithubQuota(body: unknown): ProviderQuotaResult {
  const payload = quotaRecord(body);
  const plan = text(payload.copilot_plan) ?? text(payload.sku) ?? text(payload.plan);
  const windows: ProviderQuotaWindow[] = [];
  const quotas = quotaRecord(payload.limited_user_quotas ?? payload.monthly_quotas);
  const remaining = quotaRecord(payload.limited_user_quotas_remaining);
  const reset = isoDate(payload.limited_user_reset_date) ?? isoDate(payload.quota_reset_date);
  for (const [kind, rawLimit] of Object.entries(quotas)) {
    const limit = number(rawLimit);
    if (limit === null || limit <= 0) continue;
    const left = number(remaining?.[kind]);
    const used = left === null ? null : Math.max(0, limit - left);
    windows.push(
      percentWindow(
        kind,
        kind.charAt(0).toUpperCase() + kind.slice(1),
        used === null ? null : (used / limit) * 100,
        reset,
        used,
        limit,
      ),
    );
  }
  return { source: "github", plan, windows, error: null };
}

export async function fetchGithubQuota(
  credential: string,
  fetcher: FetchLike,
): Promise<ProviderQuotaResult> {
  const parsed = parseGithubCredential(credential);
  // The usage endpoint authenticates with the GitHub token. When the envelope
  // predates that field, the minted token is sent instead and the upstream
  // answers with an auth error that surfaces honestly rather than as a
  // fabricated window.
  const token = parsed.github ?? parsed.access;
  const domain = resolveGithubEnterpriseDomain() || "github.com";
  const body = await getJson(
    `https://api.${domain}/copilot_internal/v2/token`,
    {
      authorization: `Bearer ${token}`,
      ...GITHUB_REQUEST_HEADERS,
    },
    fetcher,
  );
  return parseGithubQuota(body);
}
