// CodeBuddy International adapter — exact provider contract.
// Canonical provider ID: cb
// Base (manifest-owned CODEBUDDY_BASE_URL) → Chat: base + /chat/completions
// Auth: Authorization Bearer for both api_key and oauth
// Stream: force stream=true upstream, factory reaggregates for non-stream callers
// Headers: per-provider CodeBuddy headers with fresh correlation IDs per dispatch
// Payload: leading CodeBuddy system prompt + typed user content, reasoning_summary auto only when reasoning_effort

import { OpenAICompatibleAdapter } from "../../compatible-adapter";
import type { ProviderDispatchTarget, ProviderAdapter } from "../../contracts";
import { defineModel, type ModelDefinition } from "../../model-definition";
import type { DiscoveryInput } from "../../discovery/discovery-types";
import { GatewayError } from "../../../protocol/gateway-error";
import type { CanonicalRequest } from "../../../protocol/canonical-model";
import { providerBaseUrl } from "../../metadata";
import {
  codebuddyAdapterConfig,
} from "./codebuddy-shared";
import { BUDDY_SHARED_RAW, makeBuddyModel, type BuddyRawEntry } from "./buddy-catalog-shared";
import { BUDDY_INTL_MODELS_PATH, fetchBuddyDirectoryModels } from "./buddy-discovery-shared";
import {
  applyBuddySystemPrompt,
  buddyPrePayloadCommon,
  normalizeBuddyToolNames,
} from "./buddy-chat-shared";


// Constants — public contract
export const CODEBUDDY_PROVIDER_ID = "cb" as const;
export const CODEBUDDY_BASE_URL = providerBaseUrl("cb");
// Upstream model translation — preserve provider mapping

// Payload hook — provider intl semantics
// - force stream=true
// - reasoning_summary auto only when reasoning_effort requested
// - upstreamId translation
// - leading CodeBuddy system prompt + typed user content normalization

/**
 * Leading system turn for this variant.
 *
 * The upstream validates that the wire *opens* with a `system` turn (code
 * `11128`) but does not check its text — the CN variant installs a plain
 * engineering-assistant sentence in the same slot and the gateway accepts it.
 * So this text is a product choice rather than a wire contract, and the
 * previous vendor-branded line ("You are CodeBuddy Code.") made every request
 * claim an identity the caller never chose, while also discarding whatever
 * system prompt the caller actually sent.
 *
 * The prompt is therefore a neutral assistant identity with an explicit
 * persona: pragmatic, direct, and honest — no sycophancy, no hedging, no
 * invented certainty.
 */
export const CODEBUDDY_SYSTEM_PROMPT =
  "You are a pragmatic and direct software engineering assistant. " +
  "Be honest and truthful: state what you know, say plainly when you are unsure " +
  "or do not know, and never claim to have done something you have not done. " +
  "Prefer concrete answers over filler, and say so when a request is ambiguous " +
  "instead of guessing silently.";

function codeBuddyIntlPrePayload(
  payload: Record<string, unknown>,
  request: CanonicalRequest,
  candidate: ProviderDispatchTarget,
): void {
  buddyPrePayloadCommon(payload, request);
  const rawModel = payload["model"];
  const source =
    typeof rawModel === "string" && rawModel.length > 0
      ? rawModel
      : candidate.model_id;
  if (!source) throw new GatewayError("invalid_request", 400, "CodeBuddy model is required");
  const messages = payload["messages"];
  if (Array.isArray(messages)) {
    applyBuddySystemPrompt(messages as Array<Record<string, unknown>>, CODEBUDDY_SYSTEM_PROMPT);
  }
  normalizeBuddyToolNames(payload);
  void request;
}

// Model catalog — current CodeBuddy INTL catalog (20 entries)

const CODEBUDDY_INTL_RAW: readonly BuddyRawEntry[] = BUDDY_SHARED_RAW;

/**
 * Ids that belong to the generation rows below rather than the chat roster.
 *
 * The shared roster still lists the Gemini image ids as ordinary chat rows —
 * that is how every buddy provider has always carried them. Registering them
 * twice would put the same id in the catalog under two service kinds, so the
 * chat pass skips them and the generation rows own them instead.
 */
const CHAT_ROSTER_EXCLUDED_IDS: ReadonlySet<string> = new Set([
  "gemini-2.5-flash-image",
  "gemini-3.0-pro-image",
  "gemini-3.1-flash-image",
]);

/**
 * CodeBuddy's image generation rows.
 *
 * These ids already existed on the shared roster as ordinary `llm` chat rows,
 * which is why they were unreachable as image models: nothing downstream could
 * tell a chat model from one that returns an image, so `mediaGeneration` was
 * false for every row in the catalog. Declaring them here with an explicit
 * `serviceKind` and `output` is what makes the capability resolvable, and the
 * explicit endpoint keeps them off the chat path that `makeBuddyModel` gives
 * every roster entry.
 *
 * The endpoint is the upstream's own generation path under the same base URL,
 * not a second host: `codebuddy.ts` composes dispatch URLs as
 * `baseUrl + endpointPath`, so this stays on the provider's own wire.
 */
export const CODEBUDDY_IMAGE_MODELS: readonly ModelDefinition[] = [
  defineModel({
    id: "gemini-2.5-flash-image",
    providerId: "cb",
    serviceKind: "imageGeneration",
    wireFamily: "chat",
    endpoint: "/chat/completions",
    ctx: 1_000_000,
    out: 64_000,
    vision: true,
    output: ["image"],
    toolCall: false,
  }),
  defineModel({
    id: "gemini-3.0-pro-image",
    providerId: "cb",
    serviceKind: "imageGeneration",
    wireFamily: "chat",
    endpoint: "/chat/completions",
    ctx: 1_000_000,
    out: 64_000,
    vision: true,
    output: ["image"],
    toolCall: false,
  }),
  defineModel({
    id: "gemini-3.1-flash-image",
    providerId: "cb",
    serviceKind: "imageGeneration",
    wireFamily: "chat",
    endpoint: "/chat/completions",
    ctx: 1_000_000,
    out: 64_000,
    vision: true,
    output: ["image"],
    toolCall: false,
  }),
];

/**
 * CodeBuddy's video generation rows.
 *
 * Wired and routable but deliberately untested: no account here can reach the
 * upstream video endpoint yet, so this row exists so the surface is ready and
 * the capability is queryable rather than so traffic can flow. When it is
 * exercised, the check is that a video request resolves a candidate whose
 * `endpoint_path` is this row's and returns a non-chat body.
 */
export const CODEBUDDY_VIDEO_MODELS: readonly ModelDefinition[] = [
  defineModel({
    id: "gemini-3.1-veo",
    providerId: "cb",
    serviceKind: "videoGeneration",
    wireFamily: "chat",
    endpoint: "/chat/completions",
    ctx: 1_000_000,
    out: null,
    vision: true,
    output: ["video"],
    toolCall: false,
  }),
];

/**
 * The full cb catalog the registry loads: chat roster plus generation rows.
 *
 * Declared after the generation rows because it spreads them, and exported as
 * one list so `default-registry.ts` keeps a single import for this provider.
 */
export const CODEBUDDY_MODELS: readonly ModelDefinition[] = [
  ...CODEBUDDY_INTL_RAW.filter((entry) => !CHAT_ROSTER_EXCLUDED_IDS.has(entry[0])).map((entry) =>
    makeBuddyModel(entry, "cb"),
  ),
  ...CODEBUDDY_IMAGE_MODELS,
  ...CODEBUDDY_VIDEO_MODELS,
];

/**
 * Reads the CodeBuddy intl console directory.
 *
 * The static `CODEBUDDY_MODELS` above stays the fallback — this console is
 * documented to answer 500 intermittently — while discovery carries the
 * upstream's own limits and capability flags.
 */
export async function discoverCodeBuddyModels(
  input: DiscoveryInput,
): Promise<readonly ModelDefinition[] | null> {
  return fetchBuddyDirectoryModels({
    siteUrl: CODEBUDDY_BASE_URL,
    providerId: CODEBUDDY_PROVIDER_ID,
    credential: input.credential,
    modelsPath: BUDDY_INTL_MODELS_PATH,
    endpoint: undefined,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.fetcher ? { fetcher: input.fetcher } : {}),
  });
}

// Public factory — uses OpenAI-compatible factory but forces provider semantics
// Supports both api_key and oauth via Authorization Bearer (factory handles both)

export function createCodeBuddyAdapter(fetchImpl?: typeof fetch): ProviderAdapter {
  return new OpenAICompatibleAdapter(
    codebuddyAdapterConfig({
      providerId: CODEBUDDY_PROVIDER_ID,
      baseUrl: CODEBUDDY_BASE_URL,
      variant: "IDE",
      prePayload: codeBuddyIntlPrePayload,
      ...(fetchImpl ? { fetchImpl } : {}),
    }),
  );
}

