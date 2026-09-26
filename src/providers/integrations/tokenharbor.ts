import type { ApiKeyProviderSpec } from "./configured-provider";
import { GatewayError } from "../../transport/gateway-error";

const TOKENHARBOR_PROVIDER_ID = "tokenharbor" as const;

import { defineModel } from "../model-definition";
import type { ModelDefinition } from "../provider-registry";

// Mirrors GET /v1/models (fetched 2026-09-22, 59 rows): the fallback catalog
// is the live catalog on a bad day, so every id below must exist upstream.
export const TOKENHARBOR_FALLBACK_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "th-orchestra", providerId: "tokenharbor", reasoning: true, vision: true }),
  defineModel({ id: "claude-sonnet-4.6", providerId: "tokenharbor", reasoning: true, vision: true }),
  defineModel({ id: "claude-opus-5", providerId: "tokenharbor", ctx: 1_000_000, reasoning: true, vision: true }),
  defineModel({ id: "claude-sonnet-5", providerId: "tokenharbor", ctx: 1_000_000, reasoning: true, vision: true }),
  defineModel({ id: "grok-4.6", providerId: "tokenharbor", ctx: 500_000, reasoning: true, vision: true }),
  defineModel({ id: "glm-5.3", providerId: "tokenharbor", ctx: 200_000, reasoning: true }),
  defineModel({ id: "kimi-k3", providerId: "tokenharbor", ctx: 1_048_576, reasoning: true, vision: true }),
  defineModel({ id: "kimi-k2.6", providerId: "tokenharbor", ctx: 262_144, reasoning: true }),
  defineModel({ id: "mimo-v2.5-pro", providerId: "tokenharbor", ctx: 1_048_576, reasoning: true, vision: true }),
  defineModel({ id: "mimo-v2.5", providerId: "tokenharbor", ctx: 1_048_576, reasoning: true, vision: true }),
  defineModel({ id: "gemini-3.8-flash", providerId: "tokenharbor", ctx: 1_000_000, reasoning: true, vision: true }),
  defineModel({ id: "deepseek-v4-flash", providerId: "tokenharbor", reasoning: true }),
  defineModel({ id: "claude-fable-5.1", providerId: "tokenharbor", ctx: 1_000_000, reasoning: true, vision: true }),
  defineModel({ id: "qwen3.7-max", providerId: "tokenharbor", reasoning: true }),
  defineModel({ id: "glm-5.1", providerId: "tokenharbor", reasoning: true }),
  defineModel({ id: "deepseek-v4-pro", providerId: "tokenharbor", reasoning: true }),
  defineModel({ id: "claude-fable-5", providerId: "tokenharbor", ctx: 1_000_000, reasoning: true, vision: true }),
  defineModel({ id: "claude-opus-4.8", providerId: "tokenharbor", reasoning: true, vision: true }),
  defineModel({ id: "gpt-5.5", providerId: "tokenharbor", reasoning: true, vision: true }),
  defineModel({ id: "qwen3.8-max", providerId: "tokenharbor", reasoning: true, vision: true }),
  defineModel({ id: "glm-5.3-flash", providerId: "tokenharbor", ctx: 1_000_000, reasoning: true }),
  defineModel({ id: "gemini-3.7-flash", providerId: "tokenharbor", ctx: 1_048_576, reasoning: true, vision: true }),
  defineModel({ id: "grok-4.5", providerId: "tokenharbor", ctx: 500_000, reasoning: true, vision: true }),
  defineModel({ id: "muse-spark-1.2", providerId: "tokenharbor", ctx: 1_048_576, reasoning: true, vision: true }),
  defineModel({ id: "muse-spark-1-3", providerId: "tokenharbor", ctx: 1_048_576, reasoning: true, vision: true }),
  defineModel({ id: "gpt-6-astra", providerId: "tokenharbor", ctx: 1_050_000, reasoning: true, vision: true }),
  defineModel({ id: "deepseek-v4.1-flash", providerId: "tokenharbor", ctx: 1_048_576, reasoning: true }),
  defineModel({ id: "gemini-3.6-flash", providerId: "tokenharbor", ctx: 1_000_000, reasoning: true, vision: true }),
  defineModel({ id: "glm-5.2", providerId: "tokenharbor", ctx: 1_000_000, reasoning: true }),
  defineModel({ id: "gpt-5.6-luna", providerId: "tokenharbor", reasoning: true, vision: true }),
  defineModel({ id: "gpt-5.6-sol", providerId: "tokenharbor", reasoning: true, vision: true }),
  defineModel({ id: "gpt-5.6-terra", providerId: "tokenharbor", reasoning: true, vision: true }),
  defineModel({ id: "muse-spark-1.1", providerId: "tokenharbor", ctx: 1_048_576, reasoning: true, vision: true }),
  defineModel({ id: "qwen3.6-27b", providerId: "tokenharbor", reasoning: true, vision: true }),
  defineModel({ id: "qwen3.6-flash", providerId: "tokenharbor", reasoning: true }),
  defineModel({ id: "deepseek-v3.2", providerId: "tokenharbor", reasoning: true }),
  defineModel({ id: "qwen3.5-27b", providerId: "tokenharbor", reasoning: true }),
  defineModel({ id: "qwen3.7-flash", providerId: "tokenharbor", reasoning: true }),
  defineModel({ id: "qwen3.8-27b", providerId: "tokenharbor", ctx: 991_808, reasoning: true, vision: true }),
  defineModel({ id: "qwen3.8-flash", providerId: "tokenharbor", reasoning: true }),
  defineModel({ id: "claude-opus-5-fast", providerId: "tokenharbor", ctx: 1_000_000, reasoning: true, vision: true }),
  defineModel({ id: "kimi-k3-fast", providerId: "tokenharbor", ctx: 1_000_000, reasoning: true, vision: true }),
  defineModel({ id: "gpt-5.6-luna-fast", providerId: "tokenharbor", ctx: 1_050_000, reasoning: true, vision: true }),
  defineModel({ id: "gpt-5.6-sol-fast", providerId: "tokenharbor", ctx: 1_050_000, reasoning: true, vision: true }),
  defineModel({ id: "gpt-5.6-terra-fast", providerId: "tokenharbor", ctx: 1_050_000, reasoning: true, vision: true }),
  defineModel({ id: "gpt-6-astra-fast", providerId: "tokenharbor", ctx: 1_050_000, reasoning: true, vision: true }),
  defineModel({ id: "glm-5.3-fast", providerId: "tokenharbor", ctx: 1_048_576, reasoning: true }),
  defineModel({ id: "glm-5.3-flashx", providerId: "tokenharbor", ctx: 1_000_000, reasoning: true }),
  defineModel({ id: "grok-4.7", providerId: "tokenharbor", ctx: 500_000, reasoning: true, vision: true }),
  defineModel({ id: "mimo-v2.6-flash", providerId: "tokenharbor", ctx: 1_048_576, reasoning: true, vision: true }),
  defineModel({ id: "mimo-v2.6-pro", providerId: "tokenharbor", ctx: 1_048_576, reasoning: true, vision: true }),
  defineModel({ id: "mimo-v2.5:free", providerId: "tokenharbor", ctx: 1_048_576, reasoning: true, vision: true, free: true }),
  defineModel({ id: "deepseek-v4-flash:free", providerId: "tokenharbor", reasoning: true, free: true }),
  defineModel({ id: "deepseek-v4.1-flash:free", providerId: "tokenharbor", ctx: 1_048_576, reasoning: true, free: true }),
  defineModel({ id: "qwen3.8-flash:free", providerId: "tokenharbor", reasoning: true, free: true }),
  defineModel({ id: "mimo-v2.6-flash:free", providerId: "tokenharbor", ctx: 1_048_576, reasoning: true, vision: true, free: true }),
];


function tokenharborPrePayload(payload: Record<string, unknown>): void {
  const model = payload["model"];
  if (typeof model !== "string" || model.length === 0) {
    throw new GatewayError("invalid_request", 400, "TokenHarbor model is required");
  }
  // Strip accidental query-string smuggling (mirrors the factory's own guard)
  if (model.includes("?")) {
    throw new GatewayError("invalid_request", 400, "TokenHarbor model must not contain query string");
  }
}

/**
 * TokenHarbor authenticates uniformly with `Bearer thk_live_...` on both
 * surfaces, so chat and responses differ only by endpoint path. The registry
 * builds the adapter via `createApiKeyAdapter`.
 */
export const TOKENHARBOR_SPEC: ApiKeyProviderSpec = {
  provider_id: TOKENHARBOR_PROVIDER_ID,
  endpoint_paths_by_wire_family: {
    chat: "/chat/completions",
    responses: "/responses",
  },
  prePayload: tokenharborPrePayload,
};
