import { makeOpenAIAdapter, type OpenAIAdapterConfig } from "../open-sse/transport/shared";

export const openrouterConfig = {
  id: "openrouter",
  displayName: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1",
  credentialKind: "api_key",
} as const satisfies OpenAIAdapterConfig;

export const OpenRouterAdapter = makeOpenAIAdapter(openrouterConfig);
