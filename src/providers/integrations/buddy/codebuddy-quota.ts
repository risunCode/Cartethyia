import type { FetchLike, ProviderQuotaResult } from "../../quota/quota-contracts";
import { providerBaseUrl } from "../../provider-metadata";
import { buildCodeBuddyUserAgent, resolveCodeBuddyVersion } from "../../operations/client-versions";
import { codebuddyDomain } from "./codebuddy-shared";
import { fetchTencentBillingQuota } from "./buddy-quota-shared";

/**
 * CodeBuddy Tencent billing quota — exact provider mapping.
 *
 * Endpoints:
 *  - cb   → POST https://www.codebuddy.ai/v2/billing/meter/get-user-resource
 *  - cbcn → POST https://copilot.tencent.com/v2/billing/meter/get-user-resource
 * Request:  Authorization: Bearer <accessToken||apiKey>, provider transport headers,
 *           Content-Type: application/json, Accept: application/json, body "{}"
 * Response: { code: 0, data: { Response: { Data: { Accounts: [...] } } } }
 *
 * The envelope arithmetic (refill vs bonus split, cadence labels, bonus
 * numbering) is shared with the rest of the family in `buddy-quota-shared.ts`;
 * only the endpoint and identity headers are CodeBuddy-specific.
 */

export const CODEBUDDY_CN_USAGE_URL =
  `${providerBaseUrl("cbcn")}/billing/meter/get-user-resource`;
export const CODEBUDDY_INTL_USAGE_URL =
  `${providerBaseUrl("cb")}/billing/meter/get-user-resource`;

type CodeBuddyProviderId = "cb" | "cbcn";

async function cnHeaders(enterpriseId?: string): Promise<Record<string, string>> {
  await resolveCodeBuddyVersion();
  return {
    "User-Agent": buildCodeBuddyUserAgent("CLI"),
    "X-Product": "SaaS",
    "X-IDE-Type": "CLI",
    "X-IDE-Name": "CLI",
    "X-Domain": codebuddyDomain("CLI"),
    "x-requested-with": "XMLHttpRequest",
    "x-codebuddy-request": "1",
    ...(enterpriseId === undefined || enterpriseId.length === 0
      ? {}
      : { "X-Tenant-Id": enterpriseId, "X-Enterprise-Id": enterpriseId }),
  };
}

async function intlHeaders(enterpriseId?: string): Promise<Record<string, string>> {
  await resolveCodeBuddyVersion();
  return {
    "User-Agent": buildCodeBuddyUserAgent("IDE"),
    "X-Product": "SaaS",
    "X-IDE-Type": "IDE",
    "X-IDE-Name": "IDE",
    "X-Domain": codebuddyDomain("IDE"),
    "x-requested-with": "XMLHttpRequest",
    "x-codebuddy-request": "1",
    ...(enterpriseId === undefined || enterpriseId.length === 0
      ? {}
      : { "X-Tenant-Id": enterpriseId, "X-Enterprise-Id": enterpriseId }),
  };
}

function parseProviderId(providerId: string): CodeBuddyProviderId {
  const value = providerId.trim().toLowerCase();
  if (value === "cb") return "cb";
  if (value === "cbcn") return "cbcn";
  throw new Error(`Unsupported CodeBuddy provider ${providerId}`);
}

async function providerConfig(
  providerId: CodeBuddyProviderId,
  enterpriseId?: string,
): Promise<{
  url: string;
  headers: Record<string, string>;
  display: string;
}> {
  if (providerId === "cb") {
    return { url: CODEBUDDY_INTL_USAGE_URL, headers: await intlHeaders(enterpriseId), display: "CodeBuddy" };
  }
  return { url: CODEBUDDY_CN_USAGE_URL, headers: await cnHeaders(enterpriseId), display: "CodeBuddy CN" };
}

/**
 * Fetches CodeBuddy quota for either provider (cn/intl) via the Tencent billing endpoint.
 *
 * Provider-specific wiring:
 *  - cn:   POST https://copilot.tencent.com/v2/billing/meter/get-user-resource
 *          headers: CLI/<resolved-version>, X-IDE-Type CLI, etc.
 *  - intl: POST https://www.codebuddy.ai/v2/billing/meter/get-user-resource
 *          headers: IDE/<resolved-version>, X-IDE-Type IDE, etc.
 *
 * Auth: `Authorization: Bearer <credential>` (credential_kind api_key and oauth
 *       both use Bearer; the caller passes the resolved secret).
 */
export async function fetchCodeBuddyQuota(
  credential: string,
  fetcher: FetchLike,
  providerId: string = "cbcn",
  enterpriseId?: string,
): Promise<ProviderQuotaResult> {
  const source = parseProviderId(providerId);
  const cfg = await providerConfig(source, enterpriseId);
  return fetchTencentBillingQuota({
    source,
    display: cfg.display,
    url: cfg.url,
    headers: cfg.headers,
    credential,
    fetcher,
    defaultPlan: "CodeBuddy",
  });
}

// Convenience wrappers for direct fetcher wiring (canonical source IDs)
export const fetchCodeBuddyCnQuota = (
  credential: string,
  fetcher: FetchLike,
): Promise<ProviderQuotaResult> => fetchCodeBuddyQuota(credential, fetcher, "cbcn");

export const fetchCodeBuddyIntlQuota = (
  credential: string,
  fetcher: FetchLike,
): Promise<ProviderQuotaResult> => fetchCodeBuddyQuota(credential, fetcher, "cb");
