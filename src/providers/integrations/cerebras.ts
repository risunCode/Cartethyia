import type { FetchLike, ProviderQuotaResult } from "../quota/quota-contracts";
import { probeApiKeyConnectivity } from "../quota/quota-support";
import type { ApiKeyProviderSpec } from "./configured-provider";

const CEREBRAS_PROVIDER_ID = "cerebras" as const;

export const CEREBRAS_SPEC: ApiKeyProviderSpec = {
  provider_id: CEREBRAS_PROVIDER_ID,
  endpoint_paths_by_wire_family: {},
  supported_wire_families: ["chat"],
};

import { defineModel } from "../model-definition";
import type { ModelDefinition } from "../provider-registry";

export const CEREBRAS_MODELS: readonly ModelDefinition[] = [
  defineModel({
    id: "gpt-oss-120b",
    wireFamily: "chat",
    endpoint: "/chat/completions",
    ctx: 128000,
    out: 32768,
    reasoning: true,
    toolCall: true,
    webSearch: false,
  }),
  defineModel({
    id: "qwen-3.8-27b",
    wireFamily: "chat",
    endpoint: "/chat/completions",
    ctx: 128000,
    out: 32768,
    reasoning: true,
    toolCall: true,
    webSearch: false,
  }),
];

/** Cerebras exposes no quota surface; the account test is key validity. */
export async function fetchCerebrasQuota(
  credential: string,
  fetcher: FetchLike,
): Promise<ProviderQuotaResult> {
  return probeApiKeyConnectivity(CEREBRAS_PROVIDER_ID, credential, fetcher);
}


