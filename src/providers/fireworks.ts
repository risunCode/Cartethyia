import { makeNativeAdapter, type NativeProviderConfig } from "./shared";

export const fireworksConfig = {
  id: "fireworks",
  displayName: "Fireworks AI",
  baseUrl: "https://api.fireworks.ai/inference/v1",
  credentialKind: "api_key",
  credentialUrl: "https://fireworks.ai/account/api-keys",
} as const satisfies NativeProviderConfig;

export const FireworksAdapter = makeNativeAdapter(fireworksConfig);
