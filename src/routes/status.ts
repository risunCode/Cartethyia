/**
 * GET /health and GET /v1/models — the two diagnostic/info endpoints that
 * carry no translation logic: liveness and model discovery.
 */

import { Elysia } from "elysia";
import { filterModelsForKey, resolveModelsApiKey } from "../console/proxy-auth";
import type { ApiKeyPublic } from "../console/db/repos/api-keys";
import { listAliases, listCombos } from "../console/db/repos/combos";
import { listCustomProviders } from "../console/db/repos/custom-providers";
import { listProviderModelStates } from "../console/db/repos/provider-models";
import { prefixOf } from "../routing/providerMeta";
import { ADDED_PROVIDER_IDS, type AddedProviderId } from "../routing/types";
import { providerRegistry } from "../upstream/providers";
import type { ProviderModelEntry } from "../upstream/providers/models";
import { TtlCache } from "../console/db/ttl-cache";

export const healthRoute = new Elysia().get("/health", () => ({ status: "ok", service: "cartethyia" }));

interface ModelEntry {
  id: string;
  object: "model";
  owned_by: string;
  reasoning?: boolean;
  vision?: boolean;
  context_window?: number;
  max_output_tokens?: number;
}

/**
 * Builds the public model catalog from local routing state only — no live
 * upstream call and no client-supplied credential. Provider entries use the
 * same qualified IDs accepted by dispatch; aliases, combos, custom-provider
 * models, and manually imported provider models are included as well.
 */
function modelEntry(id: string, ownedBy: string, model?: ProviderModelEntry): ModelEntry {
  return {
    id,
    object: "model",
    owned_by: ownedBy,
    ...(model?.reasoning === undefined ? {} : { reasoning: model.reasoning }),
    ...(model?.vision === undefined ? {} : { vision: model.vision }),
    ...(model?.contextWindow === undefined ? {} : { context_window: model.contextWindow }),
    ...(model?.maxOutputTokens === undefined ? {} : { max_output_tokens: model.maxOutputTokens }),
  };
}

function providerModels(providerId: AddedProviderId): ModelEntry[] {
  const provider = providerRegistry.get(providerId);
  if (!provider || providerId === "custom") return [];

  const models = new Map(provider.models.list().map((model) => [model.id, model]));
  for (const saved of listProviderModelStates(providerId)) {
    if (!saved.enabled || models.has(saved.modelId)) continue;
    models.set(saved.modelId, { id: saved.modelId });
  }

  const prefix = prefixOf(providerId);
  return [...models.values()].map((model) => modelEntry(`${prefix}/${model.id}`, providerId, model));
}

function customProviderModels(): ModelEntry[] {
  return listCustomProviders().flatMap((provider) => provider.models.map((model) => modelEntry(`${provider.slug}/${model.id}`, provider.slug, model)));
}

function configuredModelAliases(): ModelEntry[] {
  return listAliases().map(({ alias }) => modelEntry(alias, "cartethyia-alias"));
}

function configuredModelCombos(): ModelEntry[] {
  return listCombos().map(({ name }) => modelEntry(name, "cartethyia-combo"));
}

function registryModels(): ModelEntry[] {
  const entries: ModelEntry[] = [];
  for (const providerId of ADDED_PROVIDER_IDS) entries.push(...providerModels(providerId));
  entries.push(...customProviderModels(), ...configuredModelAliases(), ...configuredModelCombos());
  return entries;
}

// registryModels() reads provider_models/custom_providers/model_aliases/combos
// for every built-in provider (roughly 20 config-db reads) to build the
// catalog, then GET /v1/models dedupes it - all from scratch on every single
// call. A 5s TTL cache (single entry, matching the getRuntimeSettings
// pattern already used elsewhere) turns that into ~20 reads every 5s instead
// of ~20 reads per request; per-key filtering below still runs per request.
const dedupedCatalogCache = new TtlCache<"catalog", ModelEntry[]>(5_000);

function dedupedRegistryModels(): ModelEntry[] {
  return dedupedCatalogCache.get("catalog", () => {
    const seen = new Set<string>();
    return registryModels().filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    });
  });
}

/** Test-only: drop the cached catalog so isolated test databases don't leak into each other. */
export function resetModelCatalogCacheForTests(): void {
  dedupedCatalogCache.clear();
}

/** Returns the locally routeable models permitted by an API key. */
export function listModelsForKey(key: ApiKeyPublic): ModelEntry[] {
  return filterModelsForKey(key, dedupedRegistryModels());
}

/**
 * Returns every locally routeable model in the OpenAI-compatible
 * `{ object: "list", data: [...] }` envelope expected by external clients.
 */
export const modelsRoute = new Elysia().get("/v1/models", ({ request, set }) => {
  const auth = resolveModelsApiKey(request);
  if (auth.error) {
    set.status = auth.error.status;
    return auth.error.body;
  }

  const data = auth.key ? listModelsForKey(auth.key) : dedupedRegistryModels();
  return { object: "list" as const, data };
});
