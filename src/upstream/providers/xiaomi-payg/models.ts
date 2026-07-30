import type { ProviderModelEntry } from "../models";

// Pay-as-you-go tier, distinct from Token Plan (`../xiaomi-tokenplan/`).
// Curated down to this pair per operator preference. Verified against
// models.dev (xiaomi) 2026-07-30.
export const xiaomiPaygModels: ProviderModelEntry[] = [
  { id: "mimo-v2.5-pro", reasoning: true, contextWindow: 1048576, maxOutputTokens: 131072, pricing: { input: 0.435, output: 0.87, cacheRead: 0.0036 } },
  { id: "mimo-v2.5", reasoning: true, vision: true, contextWindow: 1048576, maxOutputTokens: 131072, pricing: { input: 0.14, output: 0.28, cacheRead: 0.0028 } },
];
