import { createModelCatalog, type ProviderModelCatalog, type ProviderModelEntry } from "../models";

// OpenCode Zen shares the same underlying model set as OpenCode Free (both
// hit https://opencode.ai/zen/v1) — Zen just requires a real, billed API key
// instead of the free tier's shared public credential, which buys higher
// rate limits and reliability instead of a different catalog.
const MODELS: ProviderModelEntry[] = [
  { id: "big-pickle", reasoning: true, vision: true, contextWindow: 200000, maxOutputTokens: 64000, description: "Big Pickle via OpenCode Zen" },
  { id: "deepseek-v4-flash-free", reasoning: true, vision: true, contextWindow: 131072, maxOutputTokens: 16384, description: "DeepSeek V4 Flash Free via OpenCode Zen" },
  { id: "mimo-v2.5-free", reasoning: true, vision: true, contextWindow: 200000, maxOutputTokens: 64000, description: "Mimo v2.5 Free via OpenCode Zen" },
  { id: "ling-3.0-flash-free", reasoning: true, vision: true, contextWindow: 200000, maxOutputTokens: 64000, description: "Ling 3.0 Flash Free via OpenCode Zen" },
  { id: "nemotron-3-ultra-free", reasoning: true, vision: true, contextWindow: 200000, maxOutputTokens: 64000, description: "Nemotron 3 Ultra Free via OpenCode Zen" },
  { id: "north-mini-code-free", reasoning: true, contextWindow: 200000, maxOutputTokens: 64000, description: "North Mini Code Free via OpenCode Zen" },
  { id: "laguna-s-2.1-free", reasoning: true, vision: true, contextWindow: 200000, maxOutputTokens: 64000, description: "Laguna S 2.1 Free via OpenCode Zen" },
];

export const openCodeZenModelCatalog: ProviderModelCatalog = createModelCatalog(MODELS);
