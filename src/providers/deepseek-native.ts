import { capabilitiesOf, makeNativeAdapter, modelOf, type NativeProviderConfig } from "./shared";

const NATIVE_SURFACES = ["openai-chat"] as const;

export const deepseekNativeConfig = {
  id: "deepseek",
  displayName: "DeepSeek",
  baseUrl: "https://api.deepseek.com/v1",
  credentialKind: "api_key",
  models: [
    modelOf("deepseek-chat", "DeepSeek V3", capabilitiesOf({ surfaces: NATIVE_SURFACES })),
    modelOf("deepseek-reasoner", "DeepSeek R1", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, toolCalls: false })),
  ],
} as const satisfies NativeProviderConfig;

export const DeepSeekNativeAdapter = makeNativeAdapter(deepseekNativeConfig);
