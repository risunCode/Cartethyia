import { capabilitiesOf, makeOpenAIAdapter, modelOf, type OpenAIAdapterConfig } from "../open-sse/transport/shared";

const NATIVE_SURFACES = ["openai-chat"] as const;

export const simpleOpenAIConfigs: readonly OpenAIAdapterConfig[] = [
  {
    id: "openrouter",
    displayName: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    credentialKind: "api_key",
  },
  {
    id: "groq",
    displayName: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    credentialKind: "api_key",
    credentialUrl: "https://console.groq.com/keys",
  },
  {
    id: "alibaba",
    displayName: "Alibaba Cloud / DashScope",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    credentialKind: "api_key",
    credentialUrl: "https://bailian.console.aliyun.com/?apiKey=1",
  },
  {
    id: "fireworks",
    displayName: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    credentialKind: "api_key",
    credentialUrl: "https://fireworks.ai/account/api-keys",
  },
  {
    id: "deepseek",
    displayName: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    credentialKind: "api_key",
    models: [
      modelOf("deepseek-chat", "DeepSeek V3", capabilitiesOf({ surfaces: NATIVE_SURFACES })),
      modelOf("deepseek-reasoner", "DeepSeek R1", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, toolCalls: false })),
    ],
  },
  {
    id: "mistral",
    displayName: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    credentialKind: "api_key",
    models: [
      modelOf("mistral-large-latest", "Mistral Large", capabilitiesOf({ surfaces: NATIVE_SURFACES })),
      modelOf("mistral-small-latest", "Mistral Small", capabilitiesOf({ surfaces: NATIVE_SURFACES })),
    ],
  },
  {
    id: "siliconflow",
    displayName: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    credentialKind: "api_key",
    models: [
      modelOf("deepseek-ai/DeepSeek-V3", "DeepSeek V3", capabilitiesOf({ surfaces: NATIVE_SURFACES })),
      modelOf("deepseek-ai/DeepSeek-R1", "DeepSeek R1", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, toolCalls: false })),
      modelOf("Qwen/Qwen3-235B-A22B-Thinking", "Qwen3 Thinking", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
    ],
  },
  {
    id: "cerebras",
    displayName: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    credentialKind: "api_key",
    models: [
      modelOf("llama-3.3-70b", "Llama 3.3 70B", capabilitiesOf({ surfaces: NATIVE_SURFACES })),
      modelOf("llama-4-scout-17b-16e-instruct", "Llama 4 Scout", capabilitiesOf({ surfaces: NATIVE_SURFACES })),
    ],
  },
  {
    id: "nvidia",
    displayName: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    credentialKind: "api_key",
    models: [
      modelOf("nvidia/llama-3.1-nemotron-ultra-253b-v1", "Nemotron Ultra 253B", capabilitiesOf({ surfaces: NATIVE_SURFACES })),
      modelOf("deepseek-ai/deepseek-r1", "DeepSeek R1", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, toolCalls: false })),
    ],
  },
  {
    id: "xiaomipg",
    displayName: "Xiaomi MiMo (PAYG)",
    baseUrl: "https://api.xiaomimimo.com/v1",
    credentialKind: "api_key",
    models: [
      modelOf("mimo-v2.5-pro", "MiMo V2.5 Pro", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
      modelOf("mimo-v2.5", "MiMo V2.5", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true })),
    ],
  },
  {
    id: "xiaomitp",
    displayName: "Xiaomi MiMo (Token Plan)",
    baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
    credentialKind: "api_key",
    models: [
      modelOf("mimo-v2.5-pro", "MiMo V2.5 Pro", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
      modelOf("mimo-v2.5", "MiMo V2.5", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true })),
    ],
  },
];

