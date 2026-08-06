import { capabilitiesOf, makeNativeAdapter, modelOf, type NativeProviderConfig } from "./shared";

const NATIVE_SURFACES = ["openai-chat"] as const;

export const blackboxaiConfig = {
  id: "blackboxai",
  displayName: "Blackbox AI",
  baseUrl: "https://api.blackbox.ai/v1",
  credentialKind: "api_key",
  models: [
    modelOf("amazon/nova-2-lite", "Nova 2 Lite", capabilitiesOf({ surfaces: NATIVE_SURFACES })),
    modelOf("amazon/nova-micro", "Nova Micro", capabilitiesOf({ surfaces: NATIVE_SURFACES })),
    modelOf("anthropic/claude-nemotron", "Claude Nemotron", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
    modelOf("arcee-ai/trinity-large-thinking", "Trinity Large Thinking", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
    modelOf("blackboxai/blackbox-pro", "Blackbox Pro", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
    modelOf("deepseek/deepseek-v4-pro", "DeepSeek V4 Pro", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
    modelOf("deepseek/deepseek-v4-flash", "DeepSeek V4 Flash", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
    modelOf("google/gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true })),
    modelOf("google/gemini-3.5-flash", "Gemini 3.5 Flash", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true })),
    modelOf("google/gemma-4-31b-it", "Gemma 4 31B IT", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true })),
    modelOf("mistral/codestral", "Codestral", capabilitiesOf({ surfaces: NATIVE_SURFACES })),
    modelOf("minimax/minimax-m2.5", "MiniMax M2.5", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
    modelOf("moonshotai/kimi-k2.7-code", "Kimi K2.7 Code", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true })),
    modelOf("moonshotai/kimi-k3", "Kimi K3", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true })),
    modelOf("nvidia/nemotron-3-ultra", "Nemotron 3 Ultra", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
    modelOf("openai/gpt-5.3-codex", "GPT-5.3 Codex", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true })),
    modelOf("openai/gpt-5.4", "GPT-5.4", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true })),
    modelOf("openai/gpt-5.4-nano", "GPT-5.4 Nano", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true })),
    modelOf("openai/gpt-5.5", "GPT-5.5", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true })),
    modelOf("openai/gpt-nemotron", "GPT Nemotron", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
    modelOf("openai/gpt-oss-120b", "GPT-OSS 120B", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true })),
    modelOf("x-ai/grok-4.3", "Grok 4.3", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true })),
    modelOf("x-ai/grok-build-0.1", "Grok Build 0.1", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true })),
    modelOf("z-ai/glm-5.2", "GLM 5.2", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
    modelOf("z-ai/glm-5.2-vercel", "GLM 5.2 Vercel", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
    modelOf("z-ai/glm-4.7-flash", "GLM 4.7 Flash", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
    modelOf("nano-banana-pro/edit", "Nano Banana Pro Edit", capabilitiesOf({ surfaces: NATIVE_SURFACES })),
    modelOf("google/imagen-3", "Imagen 3", capabilitiesOf({ surfaces: ["images"] })),
    modelOf("google/imagen-3-fast", "Imagen 3 Fast", capabilitiesOf({ surfaces: ["images"] })),
    modelOf("google/imagen-4", "Imagen 4", capabilitiesOf({ surfaces: ["images"] })),
    modelOf("google/imagen-4-fast", "Imagen 4 Fast", capabilitiesOf({ surfaces: ["images"] })),
    modelOf("google/imagen-4-ultra", "Imagen 4 Ultra", capabilitiesOf({ surfaces: ["images"] })),
    modelOf("google/nano-banana-pro", "Nano Banana Pro", capabilitiesOf({ surfaces: ["images"] })),
  ],
} as const satisfies NativeProviderConfig;

export const BlackboxAIAdapter = makeNativeAdapter(blackboxaiConfig);
