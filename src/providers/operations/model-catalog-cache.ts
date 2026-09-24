/**
 * Process-lifetime model-catalog cache.
 *
 * `bundledModelCatalog` is called during startup seeding and again whenever a
 * caller rebuilds the routing/console catalog. Caching the loader *promise*
 * (not just the resolved value) makes concurrent and repeated calls for one
 * provider share a single load, and lets the dynamic catalog imports run once
 * per process. A rejected load is evicted so a later call can retry.
 */
import type { ModelDefinition } from "../provider-registry";
import { trackModelCatalogLoad } from "../../observability/performance-metrics";

/**
 * Provider entries retained before the least-recently-used catalog is evicted.
 * One entry per provider is tiny, but an unbounded cache would pin every
 * catalog for the process lifetime.
 */
export const MODEL_CATALOG_CACHE_MAX_ENTRIES = 64;

const catalogCache = new Map<string, Promise<readonly ModelDefinition[]>>();

/**
 * Evicts the least-recently-used provider before inserting a new one once the
 * cache is at its bound. `Map` preserves insertion order and every cache hit
 * re-inserts its entry at the tail, so the head is the LRU key. Without this
 * bound the process-lifetime cache pinned one catalog per provider forever.
 */
function evictLeastRecentlyUsedCatalog(maxEntries: number): void {
  if (catalogCache.size < maxEntries) return;
  const oldestKey = catalogCache.keys().next().value;
  if (oldestKey !== undefined) catalogCache.delete(oldestKey);
}

/** Returns the cached catalog promise for `providerId`, loading it once on first call. */
export function getCachedModels(
  providerId: string,
  loader: () => Promise<readonly ModelDefinition[]>,
  maxEntries = MODEL_CATALOG_CACHE_MAX_ENTRIES,
): Promise<readonly ModelDefinition[]> {
  const cached = catalogCache.get(providerId);
  if (cached !== undefined) {
    // Refresh recency so a hot provider survives eviction pressure.
    catalogCache.delete(providerId);
    catalogCache.set(providerId, cached);
    return cached;
  }
  evictLeastRecentlyUsedCatalog(maxEntries);
  const startedAt = performance.now();
  const task = loader()
    .then((models) => {
      trackModelCatalogLoad(providerId, performance.now() - startedAt);
      return models;
    })
    .catch((error: unknown) => {
      // Never cache a failure: a transient import error must be retryable.
      catalogCache.delete(providerId);
      throw error;
    });
  catalogCache.set(providerId, task);
  return task;
}

/** Drops all cached catalogs. Test-only: keeps isolated tests from sharing state. */
export function resetModelCatalogCacheForTesting(): void {
  catalogCache.clear();
}
