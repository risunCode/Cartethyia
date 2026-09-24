import type { CanonicalRequest } from "../../transport/canonical-model";
import type { ProviderDispatchTarget, ModelDefinition } from "../provider-registry";
import { ensurePayloadModel, type ApiKeyProviderSpec } from "./configured-provider";

const BAI_PROVIDER_ID = "bai" as const;

/**
 * B.AI serves OpenAI-compatible chat and responses on one base URL. It does not
 * serve Anthropic Messages: no model is catalogued for that wire and the
 * adapter declares only the two families it can serialize.
 */


import { defineModel } from "../model-definition";


export const BAI_FALLBACK_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "gpt-5", providerId: "bai", wireFamily: "chat", reasoning: true, vision: true, webSearch: true }),
  defineModel({ id: "gemini-3-pro", providerId: "bai", wireFamily: "chat", reasoning: true, vision: true, webSearch: true }),
];


function baiPrePayload(
  payload: Record<string, unknown>,
  _request: CanonicalRequest,
  candidate: ProviderDispatchTarget,
): void {
  ensurePayloadModel(payload, candidate, "B.AI");
}

/** B.AI adapter spec; the registry builds it via `createApiKeyAdapter`. */
export const BAI_SPEC: ApiKeyProviderSpec = {
  provider_id: BAI_PROVIDER_ID,
  endpoint_paths_by_wire_family: {
    chat: "/chat/completions",
    responses: "/responses",
  },
  supported_wire_families: ["chat", "responses"],
  prePayload: baiPrePayload,
};
