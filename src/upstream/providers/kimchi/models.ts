import { createModelCatalog, type ProviderModelCatalog, type ProviderModelEntry } from "../models";

const MODELS: ProviderModelEntry[] = [
  { id: "kimi-k2.7", reasoning: true, vision: true, contextWindow: 262144, maxOutputTokens: 64000, description: "Kimi K2.7 via Kimchi" },
  { id: "glm-5.2-fp8", reasoning: true, vision: true, contextWindow: 256000, maxOutputTokens: 64000, description: "GLM 5.2 FP8 via Kimchi" },
  { id: "minimax-m3", reasoning: true, vision: true, contextWindow: 256000, maxOutputTokens: 64000, description: "MiniMax M3 via Kimchi" },
  { id: "deepseek-v4-flash", reasoning: true, vision: true, contextWindow: 256000, maxOutputTokens: 64000, description: "DeepSeek V4 Flash via Kimchi" },
  { id: "nemotron-3-ultra-fp4", reasoning: true, contextWindow: 128000, maxOutputTokens: 8192, description: "Nemotron 3 Ultra FP4 via Kimchi" },
];

export const kimchiModelCatalog: ProviderModelCatalog = createModelCatalog(MODELS);
