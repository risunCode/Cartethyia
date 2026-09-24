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
import type { ProviderAdapter, ProviderDispatchTarget } from "../../provider-registry";
import {
  WORKBUDDY_CHAT_PATH,
  workbuddyAdapterConfig,
} from "./workbuddy-shared";
import { makeBuddyModel, type BuddyRawEntry } from "./buddy-catalog-shared";
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

const WORKBUDDY_SYSTEM_PROMPT = "You are WorkBuddy AI.";

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
const WORKBUDDY_RAW: readonly BuddyRawEntry[] = [
  ["auto", "Auto", true, true, 168_000, null],
  ["default-model", "Default Model", true, false, 128_000, 64_000],
  ["fast-model", "Fast Model", true, false, 128_000, 64_000],
  ["balanced-model", "Balanced Model", true, false, 128_000, 64_000],
  ["deep-model", "Deep Model", true, false, 128_000, 64_000],
  ["deepseek-v4.1-flash", "DeepSeek V4.1 Flash", true, false, 1_000_000, 384_000],
  ["deepseek-v4-pro", "DeepSeek V4 Pro", true, false, 1_000_000, 384_000],
  ["deepseek-v4-flash", "DeepSeek V4 Flash", true, false, 1_000_000, 384_000],
  ["glm-5.1", "GLM-5.1", true, false, 200_000, 131_072],
  ["glm-5.2", "GLM-5.2", true, false, 1_000_000, 131_072],
  ["glm-5.3", "GLM-5.3", true, false, 1_000_000, 131_072],
  ["glm-5.3-flash", "GLM-5.3 Flash", true, false, 1_000_000, 131_072],
  ["glm-5v-turbo", "GLM-5V Turbo", true, true, 200_000, 131_072],
  ["gpt-5.3-codex", "GPT-5.3 Codex", true, true, 400_000, 128_000],
  ["gpt-5.4", "GPT-5.4", true, true, 1_050_000, 128_000],
  ["gpt-5.5", "GPT-5.5", true, true, 1_050_000, 128_000],
  ["gpt-5.6-luna", "GPT-5.6 Luna", true, true, 1_050_000, 128_000],
  ["gpt-5.6-sol", "GPT-5.6 Sol", true, true, 1_050_000, 128_000],
  ["gpt-5.6-terra", "GPT-5.6 Terra", true, true, 1_050_000, 128_000],
  ["gpt-6-astra", "GPT-6 Astra", true, true, 1_050_000, 128_000],
  ["gemini-3.5-flash", "Gemini 3.5 Flash", true, true, 1_048_576, 65_536],
  ["hy3", "Hy3", true, false, 192_000, 64_000],
  ["hy4-preview", "Hy4 Preview", true, false, 1_000_000, 64_000],
  ["hy4-preview-f", "Hy4 Preview F", true, false, 1_000_000, 64_000],
  ["kimi-k2.5", "Kimi K2.5", true, false, 164_000, 262_144],
  ["kimi-k2.6", "Kimi K2.6", true, false, 256_000, 262_144],
  ["kimi-k2.7", "Kimi K2.7", true, false, 256_000, 65_536],
  ["kimi-k3", "Kimi K3", true, false, 1_048_576, 131_072],
  ["minimax-m3", "MiniMax-M3", true, false, 512_000, 512_000],
];

export const WORKBUDDY_MODELS = WORKBUDDY_RAW.map((entry) => makeBuddyModel(entry, "workbuddy", WORKBUDDY_CHAT_PATH));

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
