import type { FetchLike, ProviderQuotaResult } from "../../quota/quota-contracts";
import { providerBaseUrl } from "../../provider-metadata";
import { buildWorkBuddyUserAgent, resolveWorkBuddyVersion } from "../../operations/client-versions";
import { WORKBUDDY_DOMAIN } from "./workbuddy-shared";
import { fetchTencentBillingQuota } from "./buddy-quota-shared";

/**
 * WorkBuddy international billing quota.
 *
 * Endpoint: POST https://www.workbuddy.ai/v2/billing/meter/get-user-resource
 * Request:  Authorization: Bearer <accessToken||apiKey>, desktop-client headers,
 *           Content-Type: application/json, Accept: application/json, body "{}"
 * Response: { code: 0, data: { Response: { Data: { Accounts: [...] } } } }
 *
 * Same Tencent billing envelope as CodeBuddy CN, so the parsing is the shared
 * one in `buddy-quota-shared.ts`; only the endpoint and identity headers are
 * WorkBuddy-specific.
 */

export const WORKBUDDY_USAGE_URL =
  `${providerBaseUrl("workbuddy")}/v2/billing/meter/get-user-resource`;

async function billingHeaders(enterpriseId?: string): Promise<Record<string, string>> {
  await resolveWorkBuddyVersion();
  return {
    "User-Agent": buildWorkBuddyUserAgent(),
    "X-Product": "SaaS",
    "X-Domain": WORKBUDDY_DOMAIN,
    "X-Requested-With": "XMLHttpRequest",
    "X-CodeBuddy-Request": "1",
    "Accept-Language": "en-US",
    ...(enterpriseId === undefined || enterpriseId.length === 0
      ? {}
      : { "X-Tenant-Id": enterpriseId, "X-Enterprise-Id": enterpriseId }),
  };
}

/**
 * Fetches WorkBuddy quota via the Tencent billing endpoint.
 *
 * Auth: `Authorization: Bearer <credential>` (api_key and oauth both use
 * Bearer; the caller passes the resolved secret).
 */
export async function fetchWorkBuddyQuota(
  credential: string,
  fetcher: FetchLike,
  enterpriseId?: string,
): Promise<ProviderQuotaResult> {
  return fetchTencentBillingQuota({
    source: "workbuddy",
    display: "WorkBuddy",
    url: WORKBUDDY_USAGE_URL,
    headers: await billingHeaders(enterpriseId),
    credential,
    fetcher,
    defaultPlan: "WorkBuddy",
  });
}
