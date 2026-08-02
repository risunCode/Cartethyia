/**
 * Provider registry — the PROVIDERS Map and providerRegistry accessor.
 * Every Cartethyia-managed provider is registered here; adding a new
 * provider means importing it and adding one line to the Map.
 */

import type { Provider } from "./types";
import { commandCodeProvider } from "./commandcode/index";
import { kimchiProvider } from "./kimchi";
import { openCodeFreeProvider } from "./opencode-free";
import { openCodeZenProvider } from "./opencode-zen";
import { devinProvider } from "./devin/index";
import { qoderProvider } from "./qoder/index";
import { dynamicProviderRouter } from "./dynamic";
import { cursorProvider } from "./cursor/index";
import { anthropicProvider } from "./anthropic";
import { codexProvider } from "./codex";
import { anthropicOAuthProvider } from "./anthropic-oauth";
import { grokCliProvider } from "./grok-cli";
import { googleAntigravityProvider } from "./google-antigravity";
import { kiroProvider } from "./kiro";
import { clineProvider } from "./cline";
import { agentRouterProvider } from "./agentrouter";
import { openaiProvider } from "./openai";
import { opencodeGoProvider } from "./opencode-go";
import { xiaomiPaygProvider } from "./xiaomi-payg";
import { xiaomiTokenPlanProvider } from "./xiaomi-tokenplan";
import { createOpenAICompatibleProvider } from "./openai-compatible";

const OPENAI_COMPATIBLE_PROVIDERS = [
  createOpenAICompatibleProvider({
    id: "blackbox",
    name: "Blackbox AI",
    icon: "blackbox",
    baseUrl: "https://api.blackbox.ai/v1",
    credentialUrl: "https://www.blackbox.ai/api-management",
    strict: true,
    models: [
      { id: "blackboxai/deepseek/deepseek-v4-flash", reasoning: true, contextWindow: 1_000_000, maxOutputTokens: 128_000, pricing: { input: 0.14, output: 0.28 } },
      { id: "blackboxai/z-ai/glm-5.2", reasoning: true, contextWindow: 1_000_000, maxOutputTokens: 128_000, pricing: { input: 1.4, output: 4.4 } },
      { id: "blackboxai/google/gemini-3.1-flash-lite", reasoning: true, contextWindow: 1_000_000, maxOutputTokens: 65_536, pricing: { input: 0.25, output: 1.5 } },
      { id: "blackboxai/nvidia/nemotron-3-nano-30b-a3b", reasoning: true, contextWindow: 131_072, maxOutputTokens: 32_768 },
      { id: "blackboxai/z-ai/glm-4.7-flash", reasoning: true, contextWindow: 131_072, maxOutputTokens: 32_768 },
      { id: "blackboxai/minimax/minimax-m2.5", reasoning: true, contextWindow: 196_608, maxOutputTokens: 32_768 },
      { id: "blackboxai/openai/gpt-5.5", reasoning: true, contextWindow: 400_000, maxOutputTokens: 128_000 },
    ],
  }),
  createOpenAICompatibleProvider({
    id: "nvidia",
    name: "NVIDIA NIM",
    icon: "nvidia",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    credentialUrl: "https://build.nvidia.com/settings/api-keys",
    models: [
      { id: "minimaxai/minimax-m2.7", reasoning: true, contextWindow: 262_144, maxOutputTokens: 32_768 },
      { id: "minimaxai/minimax-m3", reasoning: true, contextWindow: 262_144, maxOutputTokens: 32_768 },
      { id: "z-ai/glm-5.2", reasoning: true, contextWindow: 262_144, maxOutputTokens: 32_768 },
      { id: "deepseek-ai/deepseek-v4-pro", reasoning: true, contextWindow: 262_144, maxOutputTokens: 32_768 },
      { id: "deepseek-ai/deepseek-v4-flash", reasoning: true, contextWindow: 262_144, maxOutputTokens: 32_768 },
      { id: "moonshotai/kimi-k2.6", reasoning: true, vision: true, contextWindow: 262_144, maxOutputTokens: 32_768 },
      { id: "nvidia/nemotron-3-ultra-550b-a55b", reasoning: true, contextWindow: 262_144, maxOutputTokens: 32_768 },
    ],
  }),
  createOpenAICompatibleProvider({
    id: "openrouter",
    name: "OpenRouter",
    icon: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    credentialUrl: "https://openrouter.ai/settings/keys",
    models: [
      { id: "openai/gpt-4.1", vision: true, contextWindow: 1_047_576, maxOutputTokens: 32_768, pricing: { input: 2, output: 8, cacheRead: 0.5 } },
      { id: "inclusionai/ling-3.0-flash:free", reasoning: true, contextWindow: 262_144, maxOutputTokens: 32_768, pricing: { input: 0, output: 0 } },
      { id: "poolside/laguna-s-2.1:free", reasoning: true, contextWindow: 262_144, maxOutputTokens: 32_768, pricing: { input: 0, output: 0 } },
      { id: "poolside/laguna-xs-2.1:free", reasoning: true, contextWindow: 262_144, maxOutputTokens: 32_768, pricing: { input: 0, output: 0 } },
      { id: "cohere/north-mini-code:free", reasoning: true, contextWindow: 262_144, maxOutputTokens: 32_768, pricing: { input: 0, output: 0 } },
      { id: "nvidia/nemotron-3-ultra-550b-a55b:free", reasoning: true, contextWindow: 262_144, maxOutputTokens: 32_768, pricing: { input: 0, output: 0 } },
      { id: "nvidia/nemotron-3-super-120b-a12b:free", reasoning: true, contextWindow: 262_144, maxOutputTokens: 32_768, pricing: { input: 0, output: 0 } },
      { id: "nvidia/nemotron-3-nano-30b-a3b:free", reasoning: true, contextWindow: 262_144, maxOutputTokens: 32_768, pricing: { input: 0, output: 0 } },
      { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", reasoning: true, vision: true, contextWindow: 262_144, maxOutputTokens: 32_768, pricing: { input: 0, output: 0 } },
      { id: "nvidia/nemotron-nano-12b-v2-vl:free", reasoning: true, vision: true, contextWindow: 131_072, maxOutputTokens: 32_768, pricing: { input: 0, output: 0 } },
      { id: "google/gemma-4-26b-a4b-it:free", reasoning: true, contextWindow: 131_072, maxOutputTokens: 32_768, pricing: { input: 0, output: 0 } },
      { id: "google/gemma-4-31b-it:free", reasoning: true, contextWindow: 131_072, maxOutputTokens: 32_768, pricing: { input: 0, output: 0 } },
    ],
  }),
  createOpenAICompatibleProvider({
    id: "ollama",
    name: "Ollama",
    icon: "ollama",
    baseUrl: "https://ollama.com/v1",
    credentialUrl: "https://ollama.com/settings/keys",
    models: [
      { id: "gpt-oss:20b", reasoning: true, contextWindow: 131072, pricing: { input: 0.1, output: 0.3 } },
      { id: "gpt-oss:120b", reasoning: true, contextWindow: 131072, pricing: { input: 0.35, output: 0.75 } },
      { id: "gemma4:31b", reasoning: true, contextWindow: 131072, pricing: { input: 0.075, output: 0.3 } },
      { id: "minimax-m2.5", reasoning: true, contextWindow: 1000000, pricing: { input: 0.2, output: 0.8 } },
      { id: "minimax-m3", reasoning: true, contextWindow: 1000000, pricing: { input: 0.3, output: 1.2 } },
      { id: "nemotron-3-super", reasoning: true, contextWindow: 131072, pricing: { input: 0.15, output: 0.6 } },
    ],
  }),
  createOpenAICompatibleProvider({
    id: "cerebras",
    name: "Cerebras",
    icon: "cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    credentialUrl: "https://cloud.cerebras.ai/platform/",
    models: [
      { id: "gpt-oss-120b", reasoning: true, contextWindow: 131072, maxOutputTokens: 40960, pricing: { input: 0.35, output: 0.75 } },
      { id: "zai-glm-4.7", reasoning: true, contextWindow: 131072, maxOutputTokens: 40960, pricing: { input: 2.25, output: 2.75, cacheRead: 2.25 } },
    ],
  }),
  createOpenAICompatibleProvider({
    id: "deepseek",
    name: "DeepSeek",
    icon: "deepseek",
    baseUrl: "https://api.deepseek.com",
    credentialUrl: "https://platform.deepseek.com/api_keys",
    models: [
      { id: "deepseek-v4-pro", reasoning: true, contextWindow: 1000000, maxOutputTokens: 384000, pricing: { input: 0.435, output: 0.87, cacheRead: 0.003625 } },
      { id: "deepseek-v4-flash", reasoning: true, contextWindow: 1000000, maxOutputTokens: 384000, pricing: { input: 0.14, output: 0.28, cacheRead: 0.0028 } },
    ],
  }),
  createOpenAICompatibleProvider({
    id: "siliconflow",
    name: "SiliconFlow",
    icon: "siliconflow",
    baseUrl: "https://api.siliconflow.com/v1",
    credentialUrl: "https://cloud.siliconflow.cn/account/ak",
    models: [
      { id: "Qwen/Qwen3-8B", reasoning: true, contextWindow: 131000, maxOutputTokens: 131000, pricing: { input: 0.06, output: 0.06 } },
      { id: "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B", reasoning: true, contextWindow: 131000, maxOutputTokens: 16384, pricing: { input: 0.07, output: 0.07 } },
      { id: "deepseek-ai/DeepSeek-V3", reasoning: true, contextWindow: 164000, maxOutputTokens: 164000, pricing: { input: 0.25, output: 1 } },
    ],
  }),
  createOpenAICompatibleProvider({
    id: "mistral",
    name: "Mistral",
    icon: "mistral",
    baseUrl: "https://api.mistral.ai/v1",
    credentialUrl: "https://console.mistral.ai/api-keys/",
    models: [
      { id: "mistral-large-latest", reasoning: true, vision: true, contextWindow: 262144, maxOutputTokens: 262144, pricing: { input: 0.5, output: 1.5 } },
      { id: "mistral-medium-latest", reasoning: true, vision: true, contextWindow: 262144, maxOutputTokens: 262144, pricing: { input: 1.5, output: 7.5 } },
      { id: "mistral-small-latest", reasoning: true, vision: true, contextWindow: 256000, maxOutputTokens: 256000, pricing: { input: 0.15, output: 0.6 } },
      { id: "codestral-latest", reasoning: true, contextWindow: 256000, maxOutputTokens: 256000, pricing: { input: 0.3, output: 0.9 } },
    ],
  }),
] as const;

const PROVIDERS = new Map<Provider["id"], Provider>([
  ["commandcode", commandCodeProvider],
  ["kimchi", kimchiProvider],
  ["opencode-free", openCodeFreeProvider],
  ["agentrouter", agentRouterProvider],
  ["opencode-zen", openCodeZenProvider],
  ["devin", devinProvider],
  ["qoder", qoderProvider],
  ["custom", dynamicProviderRouter],
  ["cursor", cursorProvider],
  ["anthropic", anthropicProvider],
  ["openai-codex", codexProvider],
  ["anthropic-oauth", anthropicOAuthProvider],
  ["grok-cli", grokCliProvider],
  ["google-antigravity", googleAntigravityProvider],
  ["kiro", kiroProvider],
  ["cline", clineProvider],
  ["openai", openaiProvider],
  ["opencode-go", opencodeGoProvider],
  ["pgxiaomi", xiaomiPaygProvider],
  ["tpxiaomi", xiaomiTokenPlanProvider],
  ...OPENAI_COMPATIBLE_PROVIDERS.map((provider) => [provider.id, provider] as const),
]);

export const providerRegistry = {
  get(provider: Provider["id"]): Provider | undefined {
    return PROVIDERS.get(provider);
  },
  /** Every registered provider — used to build the cross-provider known-model metadata index. */
  all(): Provider[] {
    return [...PROVIDERS.values()];
  },
};
