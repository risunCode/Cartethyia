import { capabilitiesOf, makeNativeAdapter, modelOf, type NativeProviderConfig } from "./shared";

const NATIVE_SURFACES = ["openai-chat"] as const;

/**
 * Blackbox AI's upstream API expects the full `blackboxai/<vendor>/<model>` id
 * in the `model` field (verified against https://api.blackbox.ai/v1/models).
 * Our routing splits the client's `blackboxai/openai/gpt-5.4` into prefix
 * `blackboxai` + modelId `openai/gpt-5.4`, so catalog IDs are the stripped
 * form and `upstreamId` carries the full id transport sends upstream.
 */

export const blackboxaiConfig = {
  id: "blackboxai",
  displayName: "Blackbox AI",
  baseUrl: "https://api.blackbox.ai/v1",
  credentialKind: "api_key",
  models: [
    modelOf("amazon/nova-2-lite", "Nova 2 Lite", capabilitiesOf({ surfaces: NATIVE_SURFACES }), { upstreamId: "blackboxai/amazon/nova-2-lite" }),
    modelOf("amazon/nova-micro", "Nova Micro", capabilitiesOf({ surfaces: NATIVE_SURFACES }), { upstreamId: "blackboxai/amazon/nova-micro" }),
    modelOf("anthropic/claude-nemotron", "Claude Nemotron", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true }), { upstreamId: "blackboxai/anthropic/claude-nemotron" }),
    modelOf("arcee-ai/trinity-large-thinking", "Trinity Large Thinking", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true }), { upstreamId: "blackboxai/arcee-ai/trinity-large-thinking" }),
    modelOf("blackbox-pro", "Blackbox Pro", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true }), { upstreamId: "blackboxai/blackbox-pro" }),
    modelOf("deepseek/deepseek-v4-pro", "DeepSeek V4 Pro", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true }), { upstreamId: "blackboxai/deepseek/deepseek-v4-pro" }),
    modelOf("deepseek/deepseek-v4-flash", "DeepSeek V4 Flash", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true }), { upstreamId: "blackboxai/deepseek/deepseek-v4-flash" }),
    modelOf("google/gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true }), { upstreamId: "blackboxai/google/gemini-3.1-flash-lite" }),
    modelOf("google/gemini-3.5-flash", "Gemini 3.5 Flash", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true }), { upstreamId: "blackboxai/google/gemini-3.5-flash" }),
    modelOf("google/gemma-4-31b-it", "Gemma 4 31B IT", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true }), { upstreamId: "blackboxai/google/gemma-4-31b-it" }),
    modelOf("mistral/codestral", "Codestral", capabilitiesOf({ surfaces: NATIVE_SURFACES }), { upstreamId: "blackboxai/mistral/codestral" }),
    modelOf("minimax/minimax-m2.5", "MiniMax M2.5", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true }), { upstreamId: "blackboxai/minimax/minimax-m2.5" }),
    modelOf("moonshotai/kimi-k2.7-code", "Kimi K2.7 Code", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true }), { upstreamId: "blackboxai/moonshotai/kimi-k2.7-code" }),
    modelOf("moonshotai/kimi-k3", "Kimi K3", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true }), { upstreamId: "blackboxai/moonshotai/kimi-k3" }),
    modelOf("nvidia/nemotron-3-ultra", "Nemotron 3 Ultra", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true }), { upstreamId: "blackboxai/nvidia/nemotron-3-ultra" }),
    modelOf("openai/gpt-5.3-codex", "GPT-5.3 Codex", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true }), { upstreamId: "blackboxai/openai/gpt-5.3-codex" }),
    modelOf("openai/gpt-5.4", "GPT-5.4", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true }), { upstreamId: "blackboxai/openai/gpt-5.4" }),
    modelOf("openai/gpt-5.4-nano", "GPT-5.4 Nano", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true }), { upstreamId: "blackboxai/openai/gpt-5.4-nano" }),
    modelOf("openai/gpt-5.5", "GPT-5.5", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true }), { upstreamId: "blackboxai/openai/gpt-5.5" }),
    modelOf("openai/gpt-nemotron", "GPT Nemotron", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true }), { upstreamId: "blackboxai/openai/gpt-nemotron" }),
    modelOf("openai/gpt-oss-120b", "GPT-OSS 120B", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true }), { upstreamId: "blackboxai/openai/gpt-oss-120b" }),
    modelOf("x-ai/grok-4.3", "Grok 4.3", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true }), { upstreamId: "blackboxai/x-ai/grok-4.3" }),
    modelOf("x-ai/grok-build-0.1", "Grok Build 0.1", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true }), { upstreamId: "blackboxai/x-ai/grok-build-0.1" }),
    modelOf("z-ai/glm-5.2", "GLM 5.2", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true }), { upstreamId: "blackboxai/z-ai/glm-5.2" }),
    modelOf("z-ai/glm-5.2-vercel", "GLM 5.2 Vercel", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true }), { upstreamId: "blackboxai/z-ai/glm-5.2-vercel" }),
    modelOf("z-ai/glm-4.7-flash", "GLM 4.7 Flash", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true }), { upstreamId: "blackboxai/z-ai/glm-4.7-flash" }),
    modelOf("nano-banana-pro/edit", "Nano Banana Pro Edit", capabilitiesOf({ surfaces: NATIVE_SURFACES }), { upstreamId: "blackboxai/nano-banana-pro/edit" }),
    modelOf("google/imagen-3", "Imagen 3", capabilitiesOf({ surfaces: ["images"] }), { upstreamId: "blackboxai/google/imagen-3" }),
    modelOf("google/imagen-3-fast", "Imagen 3 Fast", capabilitiesOf({ surfaces: ["images"] }), { upstreamId: "blackboxai/google/imagen-3-fast" }),
    modelOf("google/imagen-4", "Imagen 4", capabilitiesOf({ surfaces: ["images"] }), { upstreamId: "blackboxai/google/imagen-4" }),
    modelOf("google/imagen-4-fast", "Imagen 4 Fast", capabilitiesOf({ surfaces: ["images"] }), { upstreamId: "blackboxai/google/imagen-4-fast" }),
    modelOf("google/imagen-4-ultra", "Imagen 4 Ultra", capabilitiesOf({ surfaces: ["images"] }), { upstreamId: "blackboxai/google/imagen-4-ultra" }),
    modelOf("google/nano-banana-pro", "Nano Banana Pro", capabilitiesOf({ surfaces: ["images"] }), { upstreamId: "blackboxai/google/nano-banana-pro" }),
  ],
} as const satisfies NativeProviderConfig;

export const BlackboxAIAdapter = makeNativeAdapter(blackboxaiConfig);
