import type { OAuthTokenRecord } from "../../application/auth/credentials";
import { fetchAntigravityQuota } from "./antigravity";
import { fetchClaudeQuota } from "./claude";
import { fetchClineQuota } from "./cline";
import { fetchCodexQuota } from "./codex";
import { fetchCursorQuota } from "./cursor";
import { fetchGrokBuildQuota } from "./grok-build";
import { fetchKiroQuota } from "./kiro";
import { cleanError, unsupportedQuota } from "./shared";
import type { FetchLike, ProviderQuotaResult } from "./types";

export type { ProviderQuotaResult, ProviderQuotaWindow } from "./types";

/** Dispatches quota collection to the provider-specific quota module. */
export async function fetchProviderQuota(providerId: string, credential: string, token: OAuthTokenRecord | undefined, fetcher: FetchLike = fetch): Promise<ProviderQuotaResult> {
  const fetchedAt = new Date().toISOString();
  try {
    switch (providerId) {
      case "antigravity":
        return await fetchAntigravityQuota(credential, token, fetcher);
      case "claude":
        return await fetchClaudeQuota(credential, token, fetcher);
      case "cline":
        return await fetchClineQuota(token?.accessToken ?? credential, fetcher);
      case "codex":
        return await fetchCodexQuota(credential, token, fetcher, fetchedAt);
      case "cursor":
        return fetchCursorQuota();
      case "grok-build":
        return await fetchGrokBuildQuota(token?.accessToken ?? credential, fetcher);
      case "kiro":
        return await fetchKiroQuota(credential, token, fetcher);
      default:
        return unsupportedQuota(providerId);
    }
  } catch (error) {
    return { source: providerId, plan: null, windows: [], error: cleanError(error) };
  }
}
