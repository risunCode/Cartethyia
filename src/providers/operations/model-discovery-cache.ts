/**
 * TTL cache for credential-free model discovery.
 *
 * Only non-null, non-empty results are cached, so failed discovery stays
 * retryable. Concurrent misses for one key share one load through TtlCache.
 */
import { TtlCacheFamily } from "../../runtime/ttl-cache";
import type { ModelDefinition } from "../provider-registry";

const MODEL_DISCOVERY_CACHE_TTL_MS = 10 * 60 * 1000;
const discoveryCaches = new TtlCacheFamily<readonly ModelDefinition[]>({
  defaultTtlMs: MODEL_DISCOVERY_CACHE_TTL_MS,
});

export interface CachedModelDiscoveryOptions {
  readonly ttlMs?: number;
}

/** Returns cached models, retrying null/empty loads on the next call. */
export async function getCachedModelDiscovery(
  key: string,
  loader: () => Promise<readonly ModelDefinition[] | null>,
  options: CachedModelDiscoveryOptions = {},
): Promise<readonly ModelDefinition[] | null> {
  return discoveryCaches.for(options.ttlMs).load(key, loader, {
    namespace: "model-discovery",
    shouldCache: (models) => models.length > 0,
  });
}

/** Drops all cached discoveries. Test-only. */
export function resetModelDiscoveryCacheForTesting(): void {
  discoveryCaches.clear();
}
