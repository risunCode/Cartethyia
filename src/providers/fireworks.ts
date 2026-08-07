import { makeOpenAIAdapter, type OpenAIAdapterConfig } from "../open-sse/transport/shared";

export const fireworksConfig = {
  id: "fireworks",
  displayName: "Fireworks AI",
  baseUrl: "https://api.fireworks.ai/inference/v1",
  credentialKind: "api_key",
  credentialUrl: "https://fireworks.ai/account/api-keys",
} as const satisfies OpenAIAdapterConfig;

export const FireworksAdapter = makeOpenAIAdapter(fireworksConfig);
