import { capabilitiesOf, makeOpenAIAdapter, modelOf, type OpenAIAdapterConfig } from "../open-sse/transport/shared";

const NATIVE_SURFACES = ["openai-chat"] as const;

export const siliconflowConfig = {
  id: "siliconflow",
  displayName: "SiliconFlow",
  baseUrl: "https://api.siliconflow.cn/v1",
  credentialKind: "api_key",
  models: [
    modelOf("deepseek-ai/DeepSeek-V3", "DeepSeek V3", capabilitiesOf({ surfaces: NATIVE_SURFACES })),
    modelOf("deepseek-ai/DeepSeek-R1", "DeepSeek R1", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, toolCalls: false })),
    modelOf("Qwen/Qwen3-235B-A22B-Thinking", "Qwen3 Thinking", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
  ],
} as const satisfies OpenAIAdapterConfig;

export const SiliconFlowAdapter = makeOpenAIAdapter(siliconflowConfig);
