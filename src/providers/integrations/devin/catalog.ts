import { defineModel } from "../../model-definition";
import type { ModelDefinition } from "../../provider-registry";
import { providerBaseUrl } from "../../provider-metadata";

export const DEVIN_PROVIDER_ID = "devin" as const;
export const DEVIN_BASE_URL = providerBaseUrl(DEVIN_PROVIDER_ID);
export const DEVIN_CHAT_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage" as const;

/** Static fallback catalog; live discovery runs through GetCliModelConfigs. */
export const DEVIN_MODELS: readonly ModelDefinition[] = [
  defineModel({
    id: "swe-1-6-slow",
    wireFamily: "native",
    endpoint: DEVIN_CHAT_PATH,
    ctx: 200_000,
    out: 64_000,
    vision: true,
    reasoning: true,
    toolCall: true,
    webSearch: true,
  }),
];
