// CodeBuddy International adapter — exact provider contract.
// Canonical provider ID: cb
// Base (manifest-owned CODEBUDDY_BASE_URL) → Chat: base + /chat/completions
// Auth: Authorization Bearer for both api_key and oauth
// Stream: force stream=true upstream, factory reaggregates for non-stream callers
// Headers: per-provider CodeBuddy headers with fresh correlation IDs per dispatch
// Payload: leading CodeBuddy system prompt + typed user content, reasoning_summary auto only when reasoning_effort

import { OpenAICompatibleAdapter } from "../../compatible-adapter";
import type { ProviderDispatchTarget, ModelDefinition, ProviderAdapter } from "../../provider-registry";
import { GatewayError } from "../../../transport/gateway-error";
import type { CanonicalRequest } from "../../../transport/canonical-model";
import { providerBaseUrl } from "../../provider-metadata";
import {
  codebuddyAdapterConfig,
} from "./codebuddy-shared";
import { makeBuddyModel, type BuddyRawEntry } from "./buddy-catalog-shared";
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

const CODEBUDDY_SYSTEM_PROMPT = "You are CodeBuddy Code.";

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

const CODEBUDDY_INTL_RAW: readonly BuddyRawEntry[] = [
  ["claude-opus-4.6", "Claude Opus 4.6", true, true, 200_000, 64_000],
  ["claude-opus-4.7-1m", "Claude Opus 4.7 1M", true, true, 1_000_000, 64_000],
  ["claude-opus-5", "Claude Opus 5", true, true, 200_000, 64_000],
  ["deepseek-v4.1-flash", "DeepSeek V4.1 Flash", true, true, 1_000_000, 384_000],
  ["gemini-2.5-flash-image", "Gemini 2.5 Flash Image", true, true, 1_000_000, 64_000],
  ["gemini-3.0-pro-image", "Gemini 3.0 Pro Image", true, true, 1_000_000, 64_000],
  ["gemini-3.1-flash-image", "Gemini 3.1 Flash Image", true, true, 1_000_000, 64_000],
  ["gemini-3.5-flash", "Gemini 3.5 Flash", true, true, 1_048_576, 65_536],
  ["glm-5.2", "GLM-5.2", true, true, 200_000, 128_000],
  ["glm-5.3", "GLM-5.3", true, true, 200_000, 128_000],
  ["gpt-5.3-codex", "GPT-5.3 Codex", true, true, 400_000, 128_000],
  ["gpt-5.4", "GPT-5.4", true, true, 400_000, 128_000],
  ["gpt-5.5", "GPT-5.5", true, true, 400_000, 128_000],
  ["gpt-5.6-luna", "GPT-5.6 Luna", true, true, 400_000, 128_000],
  ["gpt-5.6-sol", "GPT-5.6 Sol", true, true, 400_000, 128_000],
  ["gpt-5.6-terra", "GPT-5.6 Terra", true, true, 400_000, 128_000],
  ["gpt-6-astra", "GPT-6 Astra", true, true, 400_000, 128_000],
  ["gpt-image-2", "GPT-Image-2", true, true, 400_000, 128_000],
  ["hy3", "Hy3", true, false, 1_000_000, 64_000, true],
  ["hy4-preview", "Hy4 Preview", true, false, 1_000_000, 64_000, true],
  ["hy4-preview-f", "Hy4 Preview F", true, false, 1_000_000, 64_000, true],
  ["kimi-k2.5", "Kimi K2.5", true, false, 164_000, 262_144],
  ["kimi-k2.6", "Kimi K2.6", true, false, 256_000, 262_144],
  ["kimi-k2.7", "Kimi K2.7", true, false, 256_000, 65_536],
  ["kimi-k3", "Kimi K3", true, true, 262_144, 262_144],
  ["minimax-m3", "MiniMax-M3", true, true, 1_000_000, 512_000],
];

export const CODEBUDDY_MODELS: readonly ModelDefinition[] = CODEBUDDY_INTL_RAW.map((entry) => makeBuddyModel(entry, "cb"));

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

