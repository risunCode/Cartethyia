import type { ApiKeyProviderSpec } from "./configured-provider";

const XIAOMIPG_PROVIDER_ID = "xiaomipg" as const;
const XIAOMITP_PROVIDER_ID = "xiaomitp" as const;



import { defineModel } from "../model-definition";
import type { ModelDefinition } from "../provider-registry";

export const XIAOMI_MODELS: readonly ModelDefinition[] = [
  defineModel({
    id: "mimo-v2.5-pro",
    wireFamily: "chat",
    endpoint: "/chat/completions",
    ctx: 131072,
    out: 16384,
    reasoning: true,
    toolCall: true,
    webSearch: false,
  }),
  defineModel({
    id: "mimo-v2.5",
    wireFamily: "chat",
    endpoint: "/chat/completions",
    ctx: 131072,
    out: 16384,
    vision: true,
    reasoning: true,
    toolCall: true,
    webSearch: false,
  }),
];


/** Xiaomi MiMo (PAYG) — own upstream origin via `BUNDLED_PROVIDER_METADATA`. */
export const XIAOMIPG_SPEC: ApiKeyProviderSpec = {
  provider_id: XIAOMIPG_PROVIDER_ID,
  endpoint_paths_by_wire_family: {},
  supported_wire_families: ["chat"],
};

/** Xiaomi MiMo (Token Plan) — separate upstream origin. */
export const XIAOMITP_SPEC: ApiKeyProviderSpec = {
  provider_id: XIAOMITP_PROVIDER_ID,
  endpoint_paths_by_wire_family: {},
  supported_wire_families: ["chat"],
};
