import { capabilitiesOf, makeNativeAdapter, modelOf, type NativeProviderConfig } from "./shared";

const NATIVE_SURFACES = ["openai-chat"] as const;

export const nvidiaConfig = {
  id: "nvidia",
  displayName: "NVIDIA NIM",
  baseUrl: "https://integrate.api.nvidia.com/v1",
  credentialKind: "api_key",
  models: [
    modelOf("nvidia/llama-3.1-nemotron-ultra-253b-v1", "Nemotron Ultra 253B", capabilitiesOf({ surfaces: NATIVE_SURFACES })),
    modelOf("deepseek-ai/deepseek-r1", "DeepSeek R1", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, toolCalls: false })),
  ],
} as const satisfies NativeProviderConfig;

export const NvidiaNativeAdapter = makeNativeAdapter(nvidiaConfig);
