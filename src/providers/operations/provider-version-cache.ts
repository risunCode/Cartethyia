/**
 * TTL cache for best-effort version discovery. Successful values are cached;
 * null results and failures remain retryable. Concurrent misses share a load.
 */
import { TtlCacheFamily } from "../../runtime/ttl-cache";
import { retryWithBackoff } from "../../network/retry";

const VERSION_CACHE_TTL_MS = 5 * 60 * 1000;
const versionCaches = new TtlCacheFamily<string>({ defaultTtlMs: VERSION_CACHE_TTL_MS });

export interface CachedVersionOptions {
  readonly ttlMs?: number;
  readonly maxRetries?: number;
}

export async function getCachedVersion(
  key: string,
  loader: () => Promise<string | null>,
  options: CachedVersionOptions = {},
): Promise<string | null> {
  const loadWithRetry = () => retryWithBackoff(loader, { maxRetries: options.maxRetries ?? 2 });
  return versionCaches.for(options.ttlMs).load(key, loadWithRetry, {
    namespace: "provider-version",
  });
}

/** Drops all cached versions. Test-only. */
export function resetVersionCacheForTesting(): void {
  versionCaches.clear();
}
