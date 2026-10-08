// WorkBuddy international adapter — exact provider contract.
// Canonical provider ID: workbuddy
// Base (manifest-owned) → Chat: base + /v2/chat/completions
// Auth: Authorization Bearer for both api_key and oauth
// Stream: force stream=true upstream, factory reaggregates for non-stream callers
// Headers: official desktop-client identity (WorkBuddy AI brand) with fresh
//          correlation IDs + account-stable device headers per dispatch
// Payload: leading WorkBuddy system prompt + typed user content, reasoning_summary
//          auto only when reasoning_effort requested

import { OpenAICompatibleAdapter } from "../../compatible-adapter";
import { providerBaseUrl } from "../../provider-metadata";
import { GatewayError } from "../../../transport/gateway-error";
import type { CanonicalRequest } from "../../../transport/canonical-model";
import type { ProviderAdapter, ProviderDispatchTarget, ModelDefinition } from "../../provider-registry";
import type { DiscoveryInput } from "../../discovery/discovery-types";
import {
  WORKBUDDY_CHAT_PATH,
  workbuddyAdapterConfig,
} from "./workbuddy-shared";
import { BUDDY_SHARED_RAW, makeBuddyModel, type BuddyRawEntry } from "./buddy-catalog-shared";
import { BUDDY_INTL_MODELS_PATH, fetchBuddyDirectoryModels } from "./buddy-discovery-shared";
import {
  applyBuddySystemPrompt,
  buddyPrePayloadCommon,
  normalizeBuddyToolNames,
} from "./buddy-chat-shared";

// Constants — public contract
export const WORKBUDDY_PROVIDER_ID = "workbuddy" as const;
export const WORKBUDDY_BASE_URL = providerBaseUrl("workbuddy");

// Payload hook — provider semantics
// - force stream=true
// - reasoning_summary auto only when reasoning_effort requested
// - leading WorkBuddy system prompt + typed user content normalization

/**
 * Leading system turn for this variant.
 *
 * The upstream does validate the leading system turn's *text*, not just that
 * the wire opens with one: sending caller text in its place answers
 * `400 · 11128 "Illegal API invocation from an unapproved channel"` on
 * CodeBuddy, which treats that prompt as the calling channel's identity. So
 * this prompt is a wire contract, not merely a product choice — see the
 * sibling in `codebuddy.ts`. The previous line named the vendor product, which
 * made every request claim an identity the caller never chose.
 */
export const WORKBUDDY_SYSTEM_PROMPT =
  "You are a pragmatic and direct software engineering assistant. " +
  "Be honest and truthful: state what you know, say plainly when you are unsure " +
  "or do not know, and never claim to have done something you have not done. " +
  "Prefer concrete answers over filler, and say so when a request is ambiguous " +
  "instead of guessing silently.";

/**
 * Reconstructs generic function declarations when a later tool-history turn
 * arrives without the client's current `tools` array. WorkBuddy validates the
 * Chat Completions envelope against every historical tool call, so forwarding
 * `tool_calls`/`tool` messages without declarations yields model_param_invalid.
 */
function restoreHistoricalToolDefinitions(
  payload: Record<string, unknown>,
  messages: readonly Record<string, unknown>[],
): void {
  const historicalNames = new Set<string>();
  for (const message of messages) {
    if (message["role"] !== "assistant" || !Array.isArray(message["tool_calls"])) continue;
    for (const rawCall of message["tool_calls"]) {
      if (!rawCall || typeof rawCall !== "object") continue;
      const call = rawCall as Record<string, unknown>;
      const functionValue =
        call["function"] && typeof call["function"] === "object"
          ? (call["function"] as Record<string, unknown>)
          : undefined;
      const name = functionValue?.["name"];
      if (typeof name === "string" && name.trim().length > 0) historicalNames.add(name);
    }
  }
  if (historicalNames.size === 0) return;

  const existing = Array.isArray(payload["tools"])
    ? (payload["tools"] as Array<Record<string, unknown>>)
    : [];
  const definedNames = new Set<string>();
  for (const rawTool of existing) {
    if (!rawTool || typeof rawTool !== "object") continue;
    const tool = rawTool as Record<string, unknown>;
    const functionValue =
      tool["function"] && typeof tool["function"] === "object"
        ? (tool["function"] as Record<string, unknown>)
        : tool;
    if (typeof functionValue["name"] === "string") definedNames.add(functionValue["name"]);
  }
  const recovered = [...historicalNames]
    .filter((name) => !definedNames.has(name))
    .map((name) => ({
      type: "function",
      function: {
        name,
        description: "Recovered from historical tool calls.",
        parameters: { type: "object", additionalProperties: true },
      },
    }));
  if (recovered.length > 0) payload["tools"] = [...existing, ...recovered];
}


export function workbuddyPrePayload(
  payload: Record<string, unknown>,
  request: CanonicalRequest,
  candidate: ProviderDispatchTarget,
): void {
  buddyPrePayloadCommon(payload, request);
  const rawModel = payload["model"];
  const source =
    typeof rawModel === "string" && rawModel.length > 0 ? rawModel : candidate.model_id;
  if (!source) throw new GatewayError("invalid_request", 400, "WorkBuddy model is required");
  const messages = payload["messages"];
  if (Array.isArray(messages)) {
    const normalizedMessages = messages as Array<Record<string, unknown>>;
    applyBuddySystemPrompt(normalizedMessages, WORKBUDDY_SYSTEM_PROMPT);
    restoreHistoricalToolDefinitions(payload, normalizedMessages);
  }
  normalizeBuddyToolNames(payload);
  void request;
}

// Model catalog — WorkBuddy international catalog.
// Static seed derived from the reference gateway's model.json (context/output
// limits) plus its global effort table; `reasoning` marks models with a
// declared reasoning-effort scale.
const WORKBUDDY_RAW: readonly BuddyRawEntry[] = BUDDY_SHARED_RAW;
export const WORKBUDDY_MODELS = WORKBUDDY_RAW.map((entry) => makeBuddyModel(entry, "workbuddy", WORKBUDDY_CHAT_PATH));

/**
 * Reads WorkBuddy's live console directory.
 *
 * The static `WORKBUDDY_MODELS` above is the fallback: this is what the "Fetch
 * models" action persists, and it carries the upstream's own limits and
 * capability flags rather than the seed's snapshot of them.
 */
export async function discoverWorkBuddyModels(
  input: DiscoveryInput,
): Promise<readonly ModelDefinition[] | null> {
  return fetchBuddyDirectoryModels({
    siteUrl: WORKBUDDY_BASE_URL,
    providerId: WORKBUDDY_PROVIDER_ID,
    credential: input.credential,
    modelsPath: BUDDY_INTL_MODELS_PATH,
    endpoint: WORKBUDDY_CHAT_PATH,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.fetcher ? { fetcher: input.fetcher } : {}),
  });
}

// Public factory — uses the OpenAI-compatible factory but forces provider semantics.
// Supports both api_key and oauth via Authorization Bearer (factory handles both).
export function createWorkBuddyAdapter(fetchImpl?: typeof fetch): ProviderAdapter {
  return new OpenAICompatibleAdapter(
    workbuddyAdapterConfig({
      providerId: WORKBUDDY_PROVIDER_ID,
      baseUrl: WORKBUDDY_BASE_URL,
      prePayload: workbuddyPrePayload,
      ...(fetchImpl ? { fetchImpl } : {}),
    }),
  );
}
