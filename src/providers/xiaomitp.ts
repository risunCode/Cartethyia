import { capabilitiesOf, makeNativeAdapter, modelOf, type NativeProviderConfig } from "./shared";

const NATIVE_SURFACES = ["openai-chat"] as const;

export const xiaomitpConfig = {
  id: "xiaomitp",
  displayName: "Xiaomi MiMo (Token Plan)",
  baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
  credentialKind: "api_key",
  models: [
    modelOf("mimo-v2.5-pro", "MiMo V2.5 Pro", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true })),
    modelOf("mimo-v2.5", "MiMo V2.5", capabilitiesOf({ surfaces: NATIVE_SURFACES, reasoning: true, images: true })),
  ],
} as const satisfies NativeProviderConfig;

export const XiaomiTokenPlanAdapter = makeNativeAdapter(xiaomitpConfig);
