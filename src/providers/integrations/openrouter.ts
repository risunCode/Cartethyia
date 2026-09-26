import type { ApiKeyProviderSpec } from "./configured-provider";
import type { ModelDefinition } from "../provider-registry";
import { fetchOpenAICompatibleModels } from "../discovery/openai-model-discovery";
import { providerBaseUrl } from "../provider-metadata";
import type { DiscoveryInput } from "../discovery/discovery-types";

const OPENROUTER_PROVIDER_ID = "openrouter" as const;

/** OpenRouter requires these on every request for ranking/attribution. */
const OPENROUTER_REQUIRED_HEADERS: Readonly<Record<string, string>> = {
  "HTTP-Referer": "https://endpoint-proxy.local",
  "X-Title": "Endpoint Proxy",
};

/** OpenRouter adapter spec; the registry builds it via `createApiKeyAdapter`. */
export const OPENROUTER_SPEC: ApiKeyProviderSpec = {
  provider_id: OPENROUTER_PROVIDER_ID,
  endpoint_paths_by_wire_family: {},
  extra_headers: OPENROUTER_REQUIRED_HEADERS,
};

export async function discoverOpenrouterModels(
  input: DiscoveryInput,
): Promise<readonly ModelDefinition[] | null> {
  return fetchOpenAICompatibleModels({
    baseUrl: providerBaseUrl("openrouter"),
    headers: {
      authorization: `Bearer ${input.credential}`,
      ...OPENROUTER_REQUIRED_HEADERS,
    },
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.fetcher ? { fetcher: input.fetcher } : {}),
  });
}
