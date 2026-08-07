import { capabilitiesOf, makeOpenAIAdapter, modelOf, type OpenAIAdapterConfig } from "../open-sse/transport/shared";

const NATIVE_SURFACES = ["openai-chat"] as const;

export const ollamaConfig = {
  id: "ollama",
  displayName: "Ollama Cloud",
  baseUrl: "https://ollama.com/v1",
  credentialKind: "api_key",
  models: [
    modelOf("gpt-oss:20b", "GPT-OSS 20B", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
    modelOf("gpt-oss:120b", "GPT-OSS 120B", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
    modelOf("gemma4:31b", "Gemma 4 31B", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
    modelOf("minimax-m2.5", "MiniMax M2.5", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
    modelOf("minimax-m3", "MiniMax M3", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
    modelOf("nemotron-3-super", "Nemotron 3 Super", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
  ],
} as const satisfies OpenAIAdapterConfig;

export const OllamaAdapter = makeOpenAIAdapter(ollamaConfig);
