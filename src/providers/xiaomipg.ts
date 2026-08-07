import { capabilitiesOf, makeOpenAIAdapter, modelOf, type OpenAIAdapterConfig } from "../open-sse/transport/shared";

const NATIVE_SURFACES = ["openai-chat"] as const;

export const xiaomipgConfig = {
  id: "xiaomipg",
  displayName: "Xiaomi MiMo (PAYG)",
  baseUrl: "https://api.xiaomimimo.com/v1",
  credentialKind: "api_key",
  models: [
    modelOf("mimo-v2.5-pro", "MiMo V2.5 Pro", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
    modelOf("mimo-v2.5", "MiMo V2.5", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true })),
  ],
} as const satisfies OpenAIAdapterConfig;

export const XiaomiPAYGAdapter = makeOpenAIAdapter(xiaomipgConfig);
