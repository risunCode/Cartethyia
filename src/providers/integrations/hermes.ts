import type { CanonicalRequest } from "../../transport/canonical-model";
import type { ProviderDispatchTarget } from "../provider-registry";
import type { ApiKeyProviderSpec } from "./configured-provider";

const HERMES_PROVIDER_ID = "hermes" as const;

/** Portal attribution tags required by the Nous Research inference API. */
const HERMES_PORTAL_TAGS = ["product=hermes-agent", "client=hermes-client-v0.13.0"] as const;

function injectHermesTags(
  payload: Record<string, unknown>,
  _request: CanonicalRequest,
  _candidate: ProviderDispatchTarget,
): void {
  payload["tags"] = [...HERMES_PORTAL_TAGS];
}



import { defineModel } from "../model-definition";
import type { ModelDefinition } from "../provider-registry";

export const HERMES_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "poolside/laguna-s-2.1:free", ctx: 262144, out: 8192, reasoning: true }),
  defineModel({ id: "poolside/laguna-xs-2.1:free", ctx: 262144, out: 8192, reasoning: true }),
  defineModel({ id: "tencent/hy3:free", ctx: 262144, out: 8192, vision: true, reasoning: true }),
  defineModel({ id: "stepfun/step-3.7-flash:free", ctx: 262144, out: 8192, reasoning: true }),
  defineModel({ id: "upstage/solar-pro4:free", ctx: 524288, out: 8192, reasoning: true }),
  defineModel({ id: "meituan/longcat-2.0:free", ctx: 1048576, out: 8192, reasoning: true }),
];


/**
 * Nous Research (Hermes) — chat-only, with provider-specific portal `tags`
 * injected through the spec's `prePayload` hook. The registry builds the
 * adapter via `createApiKeyAdapter`.
 */
export const HERMES_SPEC: ApiKeyProviderSpec = {
  provider_id: HERMES_PROVIDER_ID,
  endpoint_paths_by_wire_family: {},
  supported_wire_families: ["chat"],
  prePayload: injectHermesTags,
};
