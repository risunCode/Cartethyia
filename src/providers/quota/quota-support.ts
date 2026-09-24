import type { FetchLike, ProviderQuotaResult } from "./quota-contracts";
import { cleanError, unsupportedQuota } from "./quota-contracts";
import { type ProviderRegistry, resolveProviderId } from "../provider-registry";
import { providerBaseUrl } from "../provider-metadata";
import { GATEWAY_PROBE_USER_AGENT } from "../operations/gateway-user-agent";
/**
 * Verifies an API key against the provider's OpenAI-compatible `/models`
 * endpoint. For providers that expose no billing/quota surface, a reachable
 * `/models` with a 2xx is the whole account test: the key is valid and the
 * account is authorized. 401/403 means the key is invalid or revoked — the one
 * definitive negative this probe can report. Anything else is an inconclusive
 * transport/wire error, surfaced as-is so callers never mistake it for a
 * credential verdict.
 */
export async function probeApiKeyConnectivity(
  source: string,
  credential: string,
  fetcher: FetchLike,
): Promise<ProviderQuotaResult> {
  const base = (providerBaseUrl(source) ?? "").replace(/\/+$/, "");
  if (!base) {
    return { source, plan: null, windows: [], error: "No API base URL is configured for this provider." };
  }
  let response: Response;
  try {
    response = await fetcher(`${base}/models`, {
      // Key-validity probes identify as the gateway, matching the probe path.
      headers: { accept: "application/json", authorization: `Bearer ${credential}`, "user-agent": GATEWAY_PROBE_USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(`Connectivity check failed: ${cleanError(error)}`);
  }
  if (response.status === 401 || response.status === 403) {
    return { source, plan: null, windows: [], error: "API key is invalid or revoked." };
  }
  if (!response.ok) {
    return { source, plan: null, windows: [], error: `Connectivity check failed: HTTP ${response.status}.` };
  }
  await response.text().catch(() => "");
  return { source, plan: null, windows: [], error: null };
}

/** Provider quota callback supplied by the canonical provider registry. */
export type QuotaFetcher = (
  credential: string,
  fetcher: FetchLike,
) => Promise<ProviderQuotaResult>;

/** Dispatches quota collection through the provider's canonical definition. */
export async function fetchProviderQuota(
  registry: ProviderRegistry,
  providerId: string,
  credential: string,
  fetcher: FetchLike = fetch,
): Promise<ProviderQuotaResult> {
  try {
    const canonicalId = resolveProviderId(providerId);
    const handler = await registry.resolveQuotaCollector(canonicalId);
    if (handler === undefined) return unsupportedQuota(providerId);
    return await handler(credential, fetcher);
  } catch (error) {
    return { source: providerId, plan: null, windows: [], error: cleanError(error) };
  }
}
