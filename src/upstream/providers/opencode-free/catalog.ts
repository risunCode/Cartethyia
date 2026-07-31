/**
 * OpenCode Free catalog — re-exports from the shared opencode-catalog module.
 *
 * Both Free and Zen hit the same unauthenticated endpoint, so the cache and
 * all helpers live in one place. This file keeps legacy import paths working
 * for existing tests and code that imported from opencode-free/catalog.
 */

export {
  type OpenCodeCapability,
  type OpenCodeModelEntry,
  fetchOpenCodeCatalog as fetchOpenCodeFreeCatalog,
  findOpenCodeModel,
  selectCapability,
  resetOpenCodeCatalogForTests as resetOpenCodeFreeCatalogForTests,
} from "../opencode-catalog";
