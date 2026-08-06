import { makeNativeAdapter, type NativeProviderConfig } from "./shared";

export const groqConfig = {
  id: "groq",
  displayName: "Groq",
  baseUrl: "https://api.groq.com/openai/v1",
  credentialKind: "api_key",
  credentialUrl: "https://console.groq.com/keys",
} as const satisfies NativeProviderConfig;

export const GroqAdapter = makeNativeAdapter(groqConfig);
