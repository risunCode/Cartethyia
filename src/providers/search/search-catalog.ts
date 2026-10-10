/**
 * Web-search model catalogs.
 *
 * Search routes use the provider's real model ids. A provider with no model
 * catalog, such as Exa or Parallel, exposes one route named after the provider.
 */
import { defineModel, type ModelDefinition } from "../model-definition";
import type { SearchProviderId } from "./search-providers";

function providerSearchModel(providerId: SearchProviderId, endpoint: string): ModelDefinition {
  return defineModel({
    id: providerId,
    providerId,
    serviceKind: "websearch",
    wireFamily: "chat",
    endpoint,
    ctx: null,
    out: null,
    toolCall: false,
  });
}

export const EXA_SEARCH_MODELS: readonly ModelDefinition[] = [providerSearchModel("exa", "/search")];
export const PARALLEL_SEARCH_MODELS: readonly ModelDefinition[] = [providerSearchModel("parallel", "/search")];
