/**
 * Web-search model catalogs.
 *
 * A search provider declares one `serviceKind: "websearch"` model whose id is
 * the search "model" a caller names on `POST /v1/search` (or through an alias /
 * combo). The row is never served on a chat wire — the canonical preparer
 * filters it out and points a chat caller at the native route — so its
 * `wireFamily` is an inert placeholder, exactly like the System One rows.
 */
import { defineModel, type ModelDefinition } from "../model-definition";
import type { SearchProviderId } from "./search-providers";

function searchModel(providerId: SearchProviderId): ModelDefinition {
  return defineModel({
    id: `${providerId}-search`,
    providerId,
    serviceKind: "websearch",
    wireFamily: "chat",
    endpoint: "/search",
    ctx: null,
    out: null,
    toolCall: false,
    webSearch: true,
  });
}

export const EXA_SEARCH_MODELS: readonly ModelDefinition[] = [searchModel("exa")];
export const TAVILY_SEARCH_MODELS: readonly ModelDefinition[] = [searchModel("tavily")];
export const BRAVE_SEARCH_MODELS: readonly ModelDefinition[] = [searchModel("brave")];
