import type { ModelDefinition } from "../provider-registry";
import type { ApiKeyProviderSpec } from "./configured-provider";

/**
 * OpenAI (API-key). Model catalog is declared in code (not DB-seeded) — see the
 * `ModelDefinition` doc comment in `providers/provider-registry.ts`.
 */
/** OpenAI (API-key) adapter spec; the registry builds it via `createApiKeyAdapter`. */
export const OPENAI_SPEC: ApiKeyProviderSpec = {
  provider_id: "openai",
  endpoint_paths_by_wire_family: {
    chat: "/v1/chat/completions",
    responses: "/v1/responses",
  },
};

import { defineModel } from "../model-definition";

export const OPENAI_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "gpt-6-astra", wireFamily: "responses", endpoint: "/v1/responses", ctx: 1050000, out: 128000, vision: true, reasoning: true }),
  defineModel({ id: "gpt-5.6-sol", wireFamily: "responses", endpoint: "/v1/responses", ctx: 1050000, out: 128000, vision: true, reasoning: true }),
  defineModel({ id: "gpt-5.6-terra", wireFamily: "responses", endpoint: "/v1/responses", ctx: 1050000, out: 128000, vision: true, reasoning: true }),
  defineModel({ id: "gpt-5.6-luna", wireFamily: "responses", endpoint: "/v1/responses", ctx: 1050000, out: 128000, vision: true, reasoning: true }),
  defineModel({ id: "gpt-5.5", wireFamily: "responses", endpoint: "/v1/responses", ctx: 1050000, out: 128000, vision: true, reasoning: true }),
  defineModel({ id: "gpt-5.4", wireFamily: "responses", endpoint: "/v1/responses", ctx: 1050000, out: 128000, vision: true, reasoning: true }),
  defineModel({ id: "gpt-5.4-mini", wireFamily: "responses", endpoint: "/v1/responses", ctx: 1050000, out: 128000, vision: true, reasoning: true }),
  defineModel({ id: "gpt-5", wireFamily: "responses", endpoint: "/v1/responses", ctx: 400000, out: 128000, vision: true, reasoning: true }),
  defineModel({ id: "gpt-5-mini", wireFamily: "responses", endpoint: "/v1/responses", ctx: 400000, out: 128000, reasoning: true }),
  defineModel({ id: "gpt-5-nano", wireFamily: "responses", endpoint: "/v1/responses", ctx: 400000, out: 128000, reasoning: true }),
  defineModel({ id: "gpt-4.1", wireFamily: "chat", endpoint: "/v1/chat/completions", ctx: 1047576, out: 32768, vision: true, reasoning: false }),
  defineModel({ id: "gpt-4.1-mini", wireFamily: "chat", endpoint: "/v1/chat/completions", ctx: 1047576, out: 32768, vision: true, reasoning: false }),
  defineModel({ id: "gpt-4.1-nano", wireFamily: "chat", endpoint: "/v1/chat/completions", ctx: 1047576, out: 32768, reasoning: false }),
  defineModel({ id: "gpt-4o", wireFamily: "chat", endpoint: "/v1/chat/completions", ctx: 128000, out: 16384, vision: true, reasoning: false }),
  defineModel({ id: "gpt-4o-mini", wireFamily: "chat", endpoint: "/v1/chat/completions", ctx: 128000, out: 16384, vision: true, reasoning: false }),
  defineModel({ id: "o3", wireFamily: "responses", endpoint: "/v1/responses", ctx: 200000, out: 100000, reasoning: true }),
  defineModel({ id: "o4-mini", wireFamily: "responses", endpoint: "/v1/responses", ctx: 200000, out: 100000, reasoning: true }),
];


