import type { ApiKeyProviderSpec } from "../integrations/shared/configured-provider";
import type { ModelDefinition } from "../model-definition";
import { fetchOpenAICompatibleModels } from "../discovery/openai-model-discovery";
import { providerBaseUrl } from "../metadata";
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


/**
 * OpenRouter's `:free` tier, as a default catalog.
 *
 * OpenRouter runs live `/api/v1/models` discovery, so this is a floor rather
 * than the only source — but without it the provider lists nothing at all
 * until a discovery run happens to fetch it, and the free tier is the one part
 * of OpenRouter an operator can use with no spend.
 *
 * Fetched 2026-10-12 from `https://openrouter.ai/api/v1/models`, which served
 * 15 `:free` rows; the 14 that the base catalog also files under `openrouter`
 * are listed here. `apodex/apodex-1.1-mini:free` is absent because the base
 * catalog has no row for it under any provider, so its limits and price would
 * have to be guessed — and a published guess reads as a measurement. Discovery
 * still picks it up, which is the correct path for a row with no catalog data.
 *
 * Every row is marked `freeTier` as well as `free`, because the two answer
 * different questions: `free` says this bills zero per token, and `freeTier` is
 * what the model list groups on so the free roster is labelled as such rather
 * than mixed in with the billed catalog.
 */
export const OPENROUTER_FREE_MODELS: readonly ModelDefinition[] = [
  defineModel({
    id: "cohere/north-mini-code:free",
    providerId: OPENROUTER_PROVIDER_ID,
    reasoning: true,
    toolCall: true,
    free: true,
    freeTier: true,
  }),
  defineModel({
    id: "dots-studio/dots-3-note-preview:free",
    providerId: OPENROUTER_PROVIDER_ID,
    reasoning: true,
    toolCall: true,
    free: true,
    freeTier: true,
  }),
  defineModel({
    id: "google/gemma-4-26b-a4b-it:free",
    providerId: OPENROUTER_PROVIDER_ID,
    reasoning: true,
    toolCall: true,
    free: true,
    freeTier: true,
  }),
  defineModel({
    id: "google/gemma-4-31b-it:free",
    providerId: OPENROUTER_PROVIDER_ID,
    reasoning: true,
    toolCall: true,
    free: true,
    freeTier: true,
  }),
  defineModel({
    id: "inclusionai/ling-3.0-flash-fin:free",
    providerId: OPENROUTER_PROVIDER_ID,
    reasoning: true,
    toolCall: true,
    free: true,
    freeTier: true,
  }),
  defineModel({
    id: "inclusionai/ling-3.0-flash-sante:free",
    providerId: OPENROUTER_PROVIDER_ID,
    reasoning: true,
    toolCall: true,
    free: true,
    freeTier: true,
  }),
  defineModel({
    id: "liquid/lfm-2.5-2.6b:free",
    providerId: OPENROUTER_PROVIDER_ID,
    reasoning: true,
    toolCall: true,
    free: true,
    freeTier: true,
  }),
  defineModel({
    id: "nex-agi/nex-n2.5-mini:free",
    providerId: OPENROUTER_PROVIDER_ID,
    reasoning: true,
    toolCall: true,
    free: true,
    freeTier: true,
  }),
  defineModel({
    id: "nex-agi/nex-n2.5-pro:free",
    providerId: OPENROUTER_PROVIDER_ID,
    reasoning: true,
    toolCall: true,
    free: true,
    freeTier: true,
  }),
  defineModel({
    id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    providerId: OPENROUTER_PROVIDER_ID,
    audio: true,
    reasoning: true,
    toolCall: true,
    free: true,
    freeTier: true,
  }),
  defineModel({
    id: "nvidia/nemotron-3-super-120b-a12b:free",
    providerId: OPENROUTER_PROVIDER_ID,
    reasoning: true,
    toolCall: true,
    free: true,
    freeTier: true,
  }),
  defineModel({
    id: "nvidia/nemotron-3-ultra-550b-a55b:free",
    providerId: OPENROUTER_PROVIDER_ID,
    reasoning: true,
    toolCall: true,
    free: true,
    freeTier: true,
  }),
  defineModel({
    id: "nvidia/nemotron-3.5-content-safety:free",
    providerId: OPENROUTER_PROVIDER_ID,
    reasoning: true,
    // A content-safety classifier, not a chat model: it is published on the
    // same free tier and serves no tool calls.
    toolCall: false,
    free: true,
    freeTier: true,
  }),
  defineModel({
    id: "nvidia/nemotron-3.5-lightning:free",
    providerId: OPENROUTER_PROVIDER_ID,
    reasoning: true,
    toolCall: true,
    free: true,
    freeTier: true,
  }),
  defineModel({
    id: "poolside/laguna-s-2.1:free",
    providerId: OPENROUTER_PROVIDER_ID,
    reasoning: true,
    toolCall: true,
    free: true,
    freeTier: true,
  }),
  defineModel({
    id: "poolside/laguna-xs-2.1:free",
    providerId: OPENROUTER_PROVIDER_ID,
    reasoning: true,
    toolCall: true,
    free: true,
    freeTier: true,
  }),
  defineModel({
    id: "qwen/qwen3.8-27b:free",
    providerId: OPENROUTER_PROVIDER_ID,
    reasoning: true,
    toolCall: true,
    free: true,
    freeTier: true,
  }),
  defineModel({
    id: "thinkingmachines/inkling-small:free",
    providerId: OPENROUTER_PROVIDER_ID,
    reasoning: true,
    toolCall: true,
    free: true,
    freeTier: true,
  }),
  defineModel({
    id: "thinkingmachines/inkling:free",
    providerId: OPENROUTER_PROVIDER_ID,
    reasoning: true,
    toolCall: true,
    free: true,
    freeTier: true,
  }),
  defineModel({
    id: "z-ai/glm-5.2:free",
    providerId: OPENROUTER_PROVIDER_ID,
    reasoning: true,
    toolCall: true,
    free: true,
    freeTier: true,
  }),
];


/**
 * OpenRouter's `:free` rows, discovered live.
 *
 * OpenRouter rotates its free tier constantly — models are added and pulled
 * within days — so a committed list is only ever a snapshot of one afternoon.
 * This is the same shape as the OpenCode Zen free fetch: filter the provider's
 * own live listing down to the free rows and mark each one `freeTier`, which is
 * what the model list groups under "Free models (auto)".
 *
 * The rows are the fetcher's own definitions, spread rather than rebuilt: it
 * has already resolved limits, pricing, and the wire family from the id, and
 * re-deriving that here would discard the resolution and let the two drift.
 */
export async function discoverOpenrouterFreeModels(
  input: DiscoveryInput,
): Promise<readonly ModelDefinition[] | null> {
  const listed = await discoverOpenrouterModels(input);
  if (listed === null) return null;
  return (
    listed
      // OpenRouter's free-tier spelling is a `:free` id suffix, matched exactly
      // rather than as a substring so a model whose own name contains "free" is
      // not swept in by accident.
      .filter((model) => model.modelId.endsWith(":free"))
      .map((model) => ({
        ...model,
        // `free` is a billing statement and `freeTier` a catalog one. The
        // `:free` suffix answers both, so both are set; the cost is left as the
        // fetcher resolved it because OpenRouter publishes a real zero price.
        free: true,
        freeTier: true,
      }))
  );
}


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
