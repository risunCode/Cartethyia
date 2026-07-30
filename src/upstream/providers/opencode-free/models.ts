import { createModelCatalog, type ProviderModelCatalog, type ProviderModelEntry } from "../models";

const MODELS: ProviderModelEntry[] = [
  { id: "big-pickle", reasoning: true, vision: true, contextWindow: 256000, maxOutputTokens: 64000, description: "Big Pickle via OpenCode Zen", pricing: { input: 0, output: 0 } },
  { id: "deepseek-v4-flash-free", reasoning: true, contextWindow: 256000, maxOutputTokens: 64000, description: "DeepSeek V4 Flash Free via OpenCode Zen", pricing: { input: 0, output: 0 } },
  { id: "mimo-v2.5-free", reasoning: true, vision: true, contextWindow: 400000, maxOutputTokens: 64000, description: "Mimo v2.5 Free via OpenCode Zen", pricing: { input: 0, output: 0 } },
  { id: "ling-3.0-flash-free", reasoning: true, vision: true, contextWindow: 256000, maxOutputTokens: 64000, description: "Ling 3.0 Flash Free via OpenCode Zen", pricing: { input: 0, output: 0 } },
  { id: "nemotron-3-ultra-free", reasoning: true, contextWindow: 400000, maxOutputTokens: 64000, description: "Nemotron 3 Ultra Free via OpenCode Zen", pricing: { input: 0, output: 0 } },
  { id: "north-mini-code-free", reasoning: true, contextWindow: 256000, maxOutputTokens: 64000, description: "North Mini Code Free via OpenCode Zen", pricing: { input: 0, output: 0 } },
  { id: "laguna-s-2.1-free", reasoning: true, contextWindow: 256000, maxOutputTokens: 64000, description: "Laguna S 2.1 Free via OpenCode Zen", pricing: { input: 0, output: 0 } },
];

export const openCodeFreeModelCatalog: ProviderModelCatalog = createModelCatalog(MODELS);
