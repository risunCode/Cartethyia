import type { FetchLike, ProviderQuotaResult } from "../../quota/quota-contracts";
import type { QuotaCollectionContext } from "../../quota/quota-support";
import { providerBaseUrl } from "../../metadata";
import {
  buildWorkBuddyUserAgent,
  getWorkBuddyClientVersion,
  getWorkBuddyCnClientVersion,
  getWorkBuddyCliVersion,
} from "../../operations/client-versions";
import { WORKBUDDY_DOMAIN } from "./workbuddy-shared";
import { fetchTencentBillingQuota } from "./buddy-quota-shared";
import { buddyAccountUid } from "./buddy-oauth-shared";

/**
 * WorkBuddy international billing quota.
 *
 * Endpoint: POST https://www.workbuddy.ai/v2/billing/meter/get-user-resource
 * Request:  Authorization: Bearer <accessToken||apiKey>, desktop-client headers,
 *           X-User-Id for the account UID, and the reference filter envelope
 *           (ProductCode p_tcaca, statuses [0, 3], 101-year package window).
 * Response: { code: 0, data: { Response: { Data: { Accounts: [...] } } } }
 *
 * Same Tencent billing envelope as CodeBuddy CN, so the parsing is the shared
 * one in `buddy-quota-shared.ts`; only the endpoint and identity headers are
 * WorkBuddy-specific.
 */

export const WORKBUDDY_USAGE_URL =
  `${providerBaseUrl("workbuddy")}/v2/billing/meter/get-user-resource`;

async function billingHeaders(
  domain: string,
  clientVersion: string,
  enterpriseId?: string,
): Promise<Record<string, string>> {
  return {
    "User-Agent": buildWorkBuddyUserAgent(clientVersion, getWorkBuddyCliVersion()),
    "X-Product": "SaaS",
    "X-Domain": domain,
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
  context?: QuotaCollectionContext,
): Promise<ProviderQuotaResult> {
  return fetchWorkBuddyQuotaFor({
    providerId: "workbuddy",
    display: "WorkBuddy",
    domain: WORKBUDDY_DOMAIN,
    credential,
    fetcher,
    ...(context === undefined ? {} : { context }),
  });
}

export async function fetchWorkBuddyCnQuota(
  credential: string,
  fetcher: FetchLike,
  context?: QuotaCollectionContext,
): Promise<ProviderQuotaResult> {
  return fetchWorkBuddyQuotaFor({
    providerId: "workbuddycn",
    display: "WorkBuddy CN",
    domain: "www.workbuddy.cn",
    credential,
    fetcher,
    ...(context === undefined ? {} : { context }),
  });
}

async function fetchWorkBuddyQuotaFor(args: {
  readonly providerId: "workbuddy" | "workbuddycn";
  readonly display: string;
  readonly domain: string;
  readonly credential: string;
  readonly fetcher: FetchLike;
  readonly context?: QuotaCollectionContext;
}): Promise<ProviderQuotaResult> {
  const { providerId, display, domain, credential, fetcher, context } = args;
  const authState = typeof context?.auth_state === "object" && context?.auth_state !== null
    ? (context.auth_state as Record<string, unknown>)
    : undefined;
  const enterpriseId = typeof authState?.enterpriseId === "string" ? authState.enterpriseId : undefined;
  const clientVersion = providerId === "workbuddycn"
    ? getWorkBuddyCnClientVersion()
    : getWorkBuddyClientVersion();
  return fetchTencentBillingQuota({
    source: providerId,
    display,
    url: `${providerBaseUrl(providerId)}/v2/billing/meter/get-user-resource`,
    headers: await billingHeaders(domain, clientVersion, enterpriseId),
    credential,
    fetcher,
    defaultPlan: display,
    uid: buddyAccountUid(credential),
  });
}
