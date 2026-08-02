import { createOpenAICompatibleProvider } from "./openai-compatible";
import type { ProviderModelEntry } from "./models";

/**
 * Xiaomi MiMo, pay-as-you-go tier. Strict: gated to exactly the curated
 * pair below per operator preference, unlike most entries in
 * `openai-compatible.ts`; an unlisted model id here must be rejected rather
 * than routed through.
 */
export const xiaomiPaygModels: ProviderModelEntry[] = [
  { id: "mimo-v2.5-pro", reasoning: true, contextWindow: 1048576, maxOutputTokens: 131072, pricing: { input: 0.435, output: 0.87, cacheRead: 0.0036 } },
  { id: "mimo-v2.5", reasoning: true, vision: true, contextWindow: 1048576, maxOutputTokens: 131072, pricing: { input: 0.14, output: 0.28, cacheRead: 0.0028 } },
];

export const xiaomiPaygProvider = createOpenAICompatibleProvider({
  id: "pgxiaomi",
  name: "Xiaomi MiMo (PAYG)",
  icon: "mimo",
  baseUrl: "https://api.xiaomimimo.com/v1",
  credentialUrl: "https://xiaomimimo.com",
  authHint: "Paste your Xiaomi MiMo pay-as-you-go API key from xiaomimimo.com.",
  strict: true,
  models: xiaomiPaygModels,
});
