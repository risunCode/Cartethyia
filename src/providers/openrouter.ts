import { makeNativeAdapter, type NativeProviderConfig } from "./shared";

export const openrouterConfig = {
  id: "openrouter",
  displayName: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1",
  credentialKind: "api_key",
} as const satisfies NativeProviderConfig;

export const OpenRouterAdapter = makeNativeAdapter(openrouterConfig);
