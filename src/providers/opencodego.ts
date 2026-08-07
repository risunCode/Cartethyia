import { capabilitiesOf, makeOpenAIAdapter, modelOf, type OpenAIAdapterConfig } from "./shared";

const NATIVE_SURFACES = ["openai-chat"] as const;

export const opencodegoConfig = {
  id: "opencodego",
  displayName: "OpenCode Go",
  baseUrl: "https://opencode.ai/zen/go/v1",
  credentialKind: "api_key",
  models: [
    modelOf("grok-4.5", "Grok 4.5", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
    modelOf("glm-5.2", "GLM 5.2", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
    modelOf("kimi-k3", "Kimi K3", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true })),
    modelOf("kimi-k2.7-code", "Kimi K2.7 Code", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
    modelOf("mimo-v2.5-pro", "MiMo V2.5 Pro", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
    modelOf("qwen3.7-max", "Qwen 3.7 Max", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
    modelOf("minimax-m3", "MiniMax M3", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
    modelOf("deepseek-v4-pro", "DeepSeek V4 Pro", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
    modelOf("deepseek-v4-flash", "DeepSeek V4 Flash", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
    modelOf("hy3", "HY3", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
  ],
} as const satisfies OpenAIAdapterConfig;

export const OpenCodeGoAdapter = makeOpenAIAdapter(opencodegoConfig);
