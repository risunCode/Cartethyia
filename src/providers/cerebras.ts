import { capabilitiesOf, makeOpenAIAdapter, modelOf, type OpenAIAdapterConfig } from "../open-sse/transport/shared";

const NATIVE_SURFACES = ["openai-chat"] as const;

export const cerebrasConfig = {
  id: "cerebras",
  displayName: "Cerebras",
  baseUrl: "https://api.cerebras.ai/v1",
  credentialKind: "api_key",
  models: [
    modelOf("llama-3.3-70b", "Llama 3.3 70B", capabilitiesOf({ surfaces: NATIVE_SURFACES })),
    modelOf("llama-4-scout-17b-16e-instruct", "Llama 4 Scout", capabilitiesOf({ surfaces: NATIVE_SURFACES })),
  ],
} as const satisfies OpenAIAdapterConfig;

export const CerebrasAdapter = makeOpenAIAdapter(cerebrasConfig);
