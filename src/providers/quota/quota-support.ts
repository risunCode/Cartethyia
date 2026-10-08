import type { FetchLike, ProviderQuotaResult } from "./quota-contracts";
import { cleanError, unsupportedQuota } from "./quota-contracts";
import { type ProviderRegistry, parseProviderId } from "../provider-registry";
import { providerBaseUrl } from "../provider-metadata";
import { createProbeFetch } from "../operations/probe-fetch";
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
    response = await createProbeFetch(fetcher)(`${base}/models`, {
      headers: { accept: "application/json", authorization: `Bearer ${credential}` },
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

/**
 * What a quota collector is told about the account whose quota it reads.
 *
 * Most collectors need only the credential. A provider whose billing surface is
 * region-scoped or profile-scoped needs the account's own configuration too,
 * and threading it as a second string would be indistinguishable from the
 * credential — so it is passed as structured context instead.
 */
export interface QuotaCollectionContext {
  /** Non-secret per-account auth configuration, as stored on the account. */
  readonly auth_state?: Readonly<Record<string, unknown>> | undefined;
  /** Stored credential kind, for surfaces that differ per auth family. */
  readonly credential_kind?: "api_key" | "oauth" | "none" | undefined;
}

/** Provider quota callback supplied by the canonical provider registry. */
export type QuotaFetcher = (
  credential: string,
  fetcher: FetchLike,
  context?: QuotaCollectionContext,
) => Promise<ProviderQuotaResult>;

/** Dispatches quota collection through the provider's canonical definition. */
export async function fetchProviderQuota(
  registry: ProviderRegistry,
  providerId: string,
  credential: string,
  fetcher: FetchLike = fetch,
  context?: QuotaCollectionContext,
): Promise<ProviderQuotaResult> {
  try {
    const canonicalId = parseProviderId(providerId);
    const handler = await registry.resolveQuotaCollector(canonicalId);
    if (handler === undefined) return unsupportedQuota(providerId);
    return await handler(credential, fetcher, context);
  } catch (error) {
    return { source: providerId, plan: null, windows: [], error: cleanError(error) };
  }
}
