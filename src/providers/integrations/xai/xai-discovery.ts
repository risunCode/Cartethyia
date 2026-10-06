/**
 * xAI Grok subscription model directory.
 *
 * `api.x.ai/v1/models` is the standard OpenAI list shape, so the shared
 * tolerant fetcher reads it — but the `xai` provider id is not the key
 * models.dev files these models under, and the base URL carries the `/v1`
 * segment already, so both are passed explicitly rather than inferred.
 */
import { fetchOpenAICompatibleModels } from "../../discovery/openai-model-discovery";
import type { DiscoveryInput } from "../../discovery/discovery-types";
import type { ModelDefinition } from "../../model-definition";
import { XAI_BASE_URL, XAI_PROVIDER_ID } from "./xai";

/** Reads the subscription's own model list. */
export async function discoverXaiModels(
  input: DiscoveryInput,
): Promise<readonly ModelDefinition[] | null> {
  return fetchOpenAICompatibleModels({
    baseUrl: XAI_BASE_URL,
    providerId: XAI_PROVIDER_ID,
    headers: { authorization: `Bearer ${input.credential}` },
    ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}
