import type { ModelDefinition, ProviderDispatchContext } from "../../provider-registry";
import { fetchOpenAICompatibleModels } from "../../discovery/openai-model-discovery";
import { normalizeBearerToken } from "../../../protocol/primitives";
import { providerBaseUrl } from "../../provider-metadata";
import type { ApiKeyProviderSpec } from "../configured-provider";
import type { DiscoveryInput } from "../../discovery/discovery-types";

const ZAI_PROVIDER_ID = "zai" as const;

/**
 * Extracts the bearer token from a stored credential that may be either a raw
 * `sk-...` string or a JSON envelope `{"accessToken": "..."}`. Malformed JSON
 * falls back to the raw string so upstream still returns a typed error.
 */
function extractAccessTokenOrRaw(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const value = parsed["accessToken"];
      if (typeof value === "string" && value.length > 0) return value;
    } catch {
      // fall through to the raw credential below
    }
  }
  return trimmed;
}

function zaiAuthHeaders(context: ProviderDispatchContext): Record<string, string> {
  const secret = context.credential.secret;
  if (!secret || secret.length === 0) return {};
  const token = normalizeBearerToken(extractAccessTokenOrRaw(new TextDecoder().decode(secret)));
  if (token.length === 0) return {};
  return { authorization: `Bearer ${token}` };
}

/**
 * Z.AI — credential codec (`extractAccessTokenOrRaw`) plus
 * `credential_forwarding: "never"` so the JSON envelope never reaches the
 * wire verbatim, while `api_key` and `oauth` accounts both work. The registry
 * builds the adapter via `createApiKeyAdapter`.
 */
export const ZAI_SPEC: ApiKeyProviderSpec = {
  provider_id: ZAI_PROVIDER_ID,
  endpoint_paths_by_wire_family: {},
  supported_wire_families: ["chat"],
  credential_forwarding: "never",
  buildExtraHeaders: zaiAuthHeaders,
};

export async function discoverZaiModels(
  input: DiscoveryInput,
): Promise<readonly ModelDefinition[] | null> {
  const token = extractAccessTokenOrRaw(input.credential);
  return fetchOpenAICompatibleModels({
    baseUrl: providerBaseUrl("zai"),
    headers: { authorization: `Bearer ${token}` },
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.fetcher ? { fetcher: input.fetcher } : {}),
  });
}
