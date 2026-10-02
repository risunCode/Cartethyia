import type { ApiKeyProviderSpec } from "./configured-provider";
import type { ModelDefinition } from "../provider-registry";
import { fetchOpenAICompatibleModels } from "../discovery/openai-model-discovery";
import { providerBaseUrl } from "../provider-metadata";
import type { DiscoveryInput } from "../discovery/discovery-types";
import { defineModel } from "../model-definition";

const OPENROUTER_PROVIDER_ID = "openrouter" as const;

/** OpenRouter requires these on every request for ranking/attribution. */
const OPENROUTER_REQUIRED_HEADERS: Readonly<Record<string, string>> = {
  "HTTP-Referer": "https://endpoint-proxy.local",
  "X-Title": "Endpoint Proxy",
};

/**
 * OpenRouter's non-chat service models.
 *
 * OpenRouter fronts the System One decision API (`/api/v1/systemone`) as
 * `typesafe/jev-1.13`, which is not a chat model: it answers `{answers}` to a
 * `{state, questions}` body. `/api/v1/models` does not list it under a wire the
 * generic fetcher can classify, so it is declared here — a `serviceKind` row
 * served by the native System One route, never by the chat surface.
 */
export const OPENROUTER_MODELS: readonly ModelDefinition[] = [
  defineModel({
    id: "typesafe/jev-1.13",
    providerId: "openrouter",
    serviceKind: "systemone",
    wireFamily: "chat",
    endpoint: "/systemone",
    ctx: 200_000,
    out: 8_192,
    toolCall: false,
  }),
];

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
