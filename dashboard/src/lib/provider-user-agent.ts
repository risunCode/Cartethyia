import type { ProviderResponse } from "../data/contracts";

/** Whether the route-level User-Agent control applies to this provider detail. */
export function providerCanConfigureUserAgent(
  provider: Pick<ProviderResponse, "isBuiltIn" | "requiresAccount" | "oauthFlows" | "hasAdapterUserAgent">,
): boolean {
  return (
    provider.isBuiltIn &&
    provider.requiresAccount &&
    provider.oauthFlows === undefined &&
    !provider.hasAdapterUserAgent
  );
}
