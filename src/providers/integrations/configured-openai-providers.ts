import type { ApiKeyProviderSpec } from "./configured-provider";
import { BARE_ROOT_ENDPOINTS } from "../../protocol/primitives";

/**
 * Builtin providers whose entire adapter contract is "bearer auth against the
 * provider's `BUNDLED_PROVIDER_METADATA` base URL, OpenAI-compatible chat +
 * responses, `/v1`-prefixed paths". They carry no catalog, no OAuth, and no
 * provider-specific payload hook, so they share one spec shape rather than
 * one module each.
 *
 * `base_url` is resolved per provider by `providerBaseUrl(provider_id)`.
 */
export const GENERIC_API_KEY_PROVIDER_IDS = [
  "groq",
  "mistral",
  "siliconflow",
  "fireworks",
  "nvidia",
  "gmi",
  "ollamacloud",
] as const;

type GenericApiKeyProviderId = (typeof GENERIC_API_KEY_PROVIDER_IDS)[number];

function genericApiKeySpec(providerId: GenericApiKeyProviderId): ApiKeyProviderSpec {
  return {
    provider_id: providerId,
    // These roots are bare hosts, so the `/v1`-prefixed wire paths stay pinned.
    endpoint_paths_by_wire_family: {
      chat: BARE_ROOT_ENDPOINTS.chat!,
      responses: BARE_ROOT_ENDPOINTS.responses!,
    },
    supported_wire_families: ["chat", "responses"],
  };
}

export const GENERIC_API_KEY_SPECS = {
  groq: genericApiKeySpec("groq"),
  mistral: genericApiKeySpec("mistral"),
  siliconflow: genericApiKeySpec("siliconflow"),
  fireworks: genericApiKeySpec("fireworks"),
  nvidia: genericApiKeySpec("nvidia"),
  gmi: genericApiKeySpec("gmi"),
  ollamacloud: genericApiKeySpec("ollamacloud"),
} satisfies Readonly<Record<GenericApiKeyProviderId, ApiKeyProviderSpec>>;
