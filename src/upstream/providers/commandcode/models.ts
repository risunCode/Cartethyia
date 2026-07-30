import { createModelCatalog, type ProviderModelCatalog, type ProviderModelEntry } from "../models";

const MODELS: ProviderModelEntry[] = [
  { id: "moonshotai/Kimi-K2.6", reasoning: true, vision: true, contextWindow: 262144, maxOutputTokens: 32768, description: "Kimi K2.6 via Command Code", pricing: { input: 1.1, output: 4.4 } },
  { id: "qwen/qwen3.5-plus", reasoning: true, vision: true, contextWindow: 131072, maxOutputTokens: 16384, description: "Qwen 3.5 Plus via Command Code", pricing: { input: 0.5, output: 2 } },
  { id: "minimax/minimax-m2.7-highspeed", reasoning: true, vision: true, contextWindow: 204800, maxOutputTokens: 32768, description: "MiniMax M2.7 highspeed via Command Code", pricing: { input: 0.3, output: 1.2 } },
  { id: "z-ai/glm-5.1", reasoning: true, vision: true, contextWindow: 202752, maxOutputTokens: 131072, description: "GLM 5.1 via Command Code", pricing: { input: 1.4, output: 4.4 } },
  { id: "deepseek/deepseek-v4-pro", reasoning: true, vision: true, contextWindow: 131072, maxOutputTokens: 32768, description: "DeepSeek V4 Pro via Command Code", pricing: { input: 0.435, output: 0.87 } },
  { id: "deepseek/deepseek-v4-flash", reasoning: true, vision: true, contextWindow: 131072, maxOutputTokens: 16384, description: "DeepSeek V4 Flash via Command Code", pricing: { input: 0.14, output: 0.28 } },
  { id: "moonshotai/Kimi-K3", reasoning: true, vision: true, contextWindow: 262144, maxOutputTokens: 32768, description: "Kimi K3 via Command Code", pricing: { input: 3, output: 15 } },
  { id: "moonshotai/Kimi-K2.7-Code", reasoning: true, vision: true, contextWindow: 262144, maxOutputTokens: 32768, description: "Kimi K2.7 Code via Command Code", pricing: { input: 0.95, output: 4 } },
  { id: "zai-org/GLM-5.2", reasoning: true, vision: true, contextWindow: 202752, maxOutputTokens: 131072, description: "GLM 5.2 via Command Code", pricing: { input: 1.4, output: 4.4 } },
  { id: "zai-org/GLM-5.2-Fast", reasoning: true, vision: true, contextWindow: 202752, maxOutputTokens: 131072, description: "GLM 5.2 Fast via Command Code", pricing: { input: 1.4, output: 4.4 } },
  { id: "MiniMaxAI/MiniMax-M3", reasoning: true, vision: true, contextWindow: 204800, maxOutputTokens: 32768, description: "MiniMax M3 via Command Code", pricing: { input: 0.3, output: 1.2 } },
  { id: "Qwen/Qwen3.6-Plus", reasoning: true, vision: true, contextWindow: 131072, maxOutputTokens: 32768, description: "Qwen 3.6 Plus via Command Code", pricing: { input: 1, output: 3 } },
  { id: "Qwen/Qwen3.7-Max", reasoning: true, vision: true, contextWindow: 131072, maxOutputTokens: 32768, description: "Qwen 3.7 Max via Command Code", pricing: { input: 2.5, output: 7.5 } },
  { id: "xiaomi/mimo-v2.5-pro", reasoning: true, vision: true, contextWindow: 131072, maxOutputTokens: 16384, description: "Xiaomi MiMo v2.5 Pro via Command Code", pricing: { input: 0.435, output: 0.87 } },
  { id: "poolside/laguna-s-2.1-free", reasoning: true, contextWindow: 131072, maxOutputTokens: 16384, description: "Poolside Laguna S 2.1 Free via Command Code", pricing: { input: 0, output: 0 } },
  { id: "nvidia/nemotron-3-ultra-550b-a55b", reasoning: true, vision: true, contextWindow: 131072, maxOutputTokens: 32768, description: "NVIDIA Nemotron 3 Ultra 550B-A55B via Command Code", pricing: { input: 1, output: 2 } },
];

export const commandCodeModelCatalog: ProviderModelCatalog = createModelCatalog(MODELS);
