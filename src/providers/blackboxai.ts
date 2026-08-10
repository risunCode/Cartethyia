import { capabilitiesOf, modelOf } from "../open-sse/transport/catalog";
import type { OpenAIAdapterConfig } from "../open-sse/transport/contracts";
import { createOpenAIAdapter } from "../open-sse/transport/openai-adapter";

const OPENAI_SURFACES = ["openai-chat", "openai-responses"] as const;
const ANTHROPIC_SURFACES = ["anthropic-messages"] as const;

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
    modelOf("amazon/nova-2-lite", "Nova 2 Lite", capabilitiesOf({ surfaces: OPENAI_SURFACES }), { upstreamId: "blackboxai/amazon/nova-2-lite" }),
    modelOf("amazon/nova-micro", "Nova Micro", capabilitiesOf({ surfaces: OPENAI_SURFACES }), { upstreamId: "blackboxai/amazon/nova-micro" }),
    modelOf("anthropic/claude-nemotron", "Claude Nemotron", capabilitiesOf({ surfaces: OPENAI_SURFACES, reasoning: true }), { upstreamId: "blackboxai/anthropic/claude-nemotron" }),
    modelOf("arcee-ai/trinity-large-thinking", "Trinity Large Thinking", capabilitiesOf({ surfaces: OPENAI_SURFACES, reasoning: true }), { upstreamId: "blackboxai/arcee-ai/trinity-large-thinking" }),
    modelOf("deepseek/deepseek-v4-pro", "DeepSeek V4 Pro", capabilitiesOf({ surfaces: OPENAI_SURFACES, reasoning: true }), { upstreamId: "blackboxai/deepseek/deepseek-v4-pro" }),
    modelOf("google/gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite", capabilitiesOf({ surfaces: OPENAI_SURFACES, reasoning: true }), { upstreamId: "blackboxai/google/gemini-3.1-flash-lite" }),
    modelOf("google/gemini-3.5-flash", "Gemini 3.5 Flash", capabilitiesOf({ surfaces: OPENAI_SURFACES, reasoning: true }), { upstreamId: "blackboxai/google/gemini-3.5-flash" }),
    modelOf("google/gemma-4-31b-it", "Gemma 4 31B IT", capabilitiesOf({ surfaces: OPENAI_SURFACES, reasoning: true }), { upstreamId: "blackboxai/google/gemma-4-31b-it" }),
    modelOf("mistral/codestral", "Codestral", capabilitiesOf({ surfaces: OPENAI_SURFACES }), { upstreamId: "blackboxai/mistral/codestral" }),
    modelOf("moonshotai/kimi-k2.7-code", "Kimi K2.7 Code", capabilitiesOf({ surfaces: OPENAI_SURFACES, reasoning: true }), { upstreamId: "blackboxai/moonshotai/kimi-k2.7-code" }),
    modelOf("nvidia/nemotron-3-ultra", "Nemotron 3 Ultra", capabilitiesOf({ surfaces: OPENAI_SURFACES, reasoning: true }), { upstreamId: "blackboxai/nvidia/nemotron-3-ultra" }),
    modelOf("openai/gpt-nemotron", "GPT Nemotron", capabilitiesOf({ surfaces: OPENAI_SURFACES, reasoning: true }), { upstreamId: "blackboxai/openai/gpt-nemotron" }),
    modelOf("openai/gpt-oss-120b", "GPT-OSS 120B", capabilitiesOf({ surfaces: OPENAI_SURFACES, reasoning: true }), { upstreamId: "blackboxai/openai/gpt-oss-120b" }),
    modelOf("x-ai/grok-4.3", "Grok 4.3", capabilitiesOf({ surfaces: OPENAI_SURFACES, reasoning: true }), { upstreamId: "blackboxai/x-ai/grok-4.3" }),
    modelOf("x-ai/grok-build-0.1", "Grok Build 0.1", capabilitiesOf({ surfaces: OPENAI_SURFACES, reasoning: true }), { upstreamId: "blackboxai/x-ai/grok-build-0.1" }),
    modelOf("z-ai/glm-5.2", "GLM 5.2", capabilitiesOf({ surfaces: ANTHROPIC_SURFACES, reasoning: true }), { upstreamId: "blackboxai/z-ai/glm-5.2" }),
    modelOf("z-ai/glm-5.2-vercel", "GLM 5.2 Vercel", capabilitiesOf({ surfaces: ANTHROPIC_SURFACES, reasoning: true }), { upstreamId: "blackboxai/z-ai/glm-5.2-vercel" }),
  ],
} as const satisfies OpenAIAdapterConfig;

export const BlackboxAIAdapter = createOpenAIAdapter(blackboxaiConfig);
