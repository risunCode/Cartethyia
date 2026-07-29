import { createModelCatalog, type ProviderModelCatalog, type ProviderModelEntry } from "../models";

const REASONING_VISION: ProviderModelEntry["capabilities"] = ["text", "vision", "reasoning", "streaming", "json", "tools"];
const VISION_STREAMING: ProviderModelEntry["capabilities"] = ["text", "vision", "streaming", "json", "tools"];
const TEXT_STREAMING: ProviderModelEntry["capabilities"] = ["text", "streaming", "json", "tools"];

const MODELS: ProviderModelEntry[] = [
  {
    id: "moonshotai/Kimi-K2.6",
    capabilities: REASONING_VISION,
    contextWindow: 262144,
    maxOutputTokens: 32768,
    description: "Kimi K2.6 via Command Code",
  },
  {
    id: "qwen/qwen3.5-plus",
    capabilities: VISION_STREAMING,
    contextWindow: 131072,
    maxOutputTokens: 16384,
    description: "Qwen 3.5 Plus via Command Code",
  },
  {
    id: "minimax/minimax-m2.7-highspeed",
    capabilities: VISION_STREAMING,
    contextWindow: 204800,
    maxOutputTokens: 32768,
    description: "MiniMax M2.7 highspeed via Command Code",
  },
  {
    id: "z-ai/glm-5.1",
    capabilities: VISION_STREAMING,
    contextWindow: 202752,
    maxOutputTokens: 131072,
    description: "GLM 5.1 via Command Code",
  },
  {
    id: "deepseek/deepseek-v4-pro",
    capabilities: REASONING_VISION,
    contextWindow: 131072,
    maxOutputTokens: 32768,
    description: "DeepSeek V4 Pro via Command Code",
  },
  {
    id: "deepseek/deepseek-v4-flash",
    capabilities: VISION_STREAMING,
    contextWindow: 131072,
    maxOutputTokens: 16384,
    description: "DeepSeek V4 Flash via Command Code",
  },
  {
    id: "moonshotai/Kimi-K3",
    capabilities: REASONING_VISION,
    contextWindow: 262144,
    maxOutputTokens: 32768,
    description: "Kimi K3 via Command Code",
  },
  {
    id: "moonshotai/Kimi-K2.7-Code",
    capabilities: REASONING_VISION,
    contextWindow: 262144,
    maxOutputTokens: 32768,
    description: "Kimi K2.7 Code via Command Code",
  },
  {
    id: "zai-org/GLM-5.2",
    capabilities: REASONING_VISION,
    contextWindow: 202752,
    maxOutputTokens: 131072,
    description: "GLM 5.2 via Command Code",
  },
  {
    id: "zai-org/GLM-5.2-Fast",
    capabilities: VISION_STREAMING,
    contextWindow: 202752,
    maxOutputTokens: 131072,
    description: "GLM 5.2 Fast via Command Code",
  },
  {
    id: "MiniMaxAI/MiniMax-M3",
    capabilities: REASONING_VISION,
    contextWindow: 204800,
    maxOutputTokens: 32768,
    description: "MiniMax M3 via Command Code",
  },
  {
    id: "Qwen/Qwen3.6-Plus",
    capabilities: REASONING_VISION,
    contextWindow: 131072,
    maxOutputTokens: 32768,
    description: "Qwen 3.6 Plus via Command Code",
  },
  {
    id: "Qwen/Qwen3.7-Max",
    capabilities: REASONING_VISION,
    contextWindow: 131072,
    maxOutputTokens: 32768,
    description: "Qwen 3.7 Max via Command Code",
  },
  {
    id: "xiaomi/mimo-v2.5-pro",
    capabilities: VISION_STREAMING,
    contextWindow: 131072,
    maxOutputTokens: 16384,
    description: "Xiaomi MiMo v2.5 Pro via Command Code",
  },
  {
    id: "poolside/laguna-s-2.1-free",
    capabilities: TEXT_STREAMING,
    contextWindow: 131072,
    maxOutputTokens: 16384,
    description: "Poolside Laguna S 2.1 Free via Command Code",
  },
  {
    id: "nvidia/nemotron-3-ultra-550b-a55b",
    capabilities: REASONING_VISION,
    contextWindow: 131072,
    maxOutputTokens: 32768,
    description: "NVIDIA Nemotron 3 Ultra 550B-A55B via Command Code",
  },
];

export const commandCodeModelCatalog: ProviderModelCatalog = createModelCatalog(MODELS);