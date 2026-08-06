import { capabilitiesOf, makeNativeAdapter, modelOf, type NativeProviderConfig } from "./shared";

const NATIVE_SURFACES = ["openai-chat"] as const;

export const mistralConfig = {
  id: "mistral",
  displayName: "Mistral",
  baseUrl: "https://api.mistral.ai/v1",
  credentialKind: "api_key",
  models: [
    modelOf("mistral-large-latest", "Mistral Large", capabilitiesOf({ surfaces: NATIVE_SURFACES })),
    modelOf("mistral-small-latest", "Mistral Small", capabilitiesOf({ surfaces: NATIVE_SURFACES })),
  ],
} as const satisfies NativeProviderConfig;

export const MistralAdapter = makeNativeAdapter(mistralConfig);
