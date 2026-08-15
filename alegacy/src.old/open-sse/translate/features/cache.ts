import type { CacheIntent, ProxyRequest } from "../../../application/contracts";
import { findCacheBreakpoint } from "../../../application/cache";

/** Returns the normalized cache intent produced during request preparation. */
export function getCacheIntent(request: ProxyRequest): CacheIntent | null {
  if (request.cacheIntent !== undefined) return request.cacheIntent;
  if (request.cacheKey === undefined) return null;
  return {
    key: request.cacheKey,
    stablePrefixFingerprint: null,
    affinityKey: null,
    policy: "automatic",
    ttl: findCacheBreakpoint(request) === null ? null : "provider-default",
  };
}

/** Reports whether the final canonical request has a native marker position. */
export function hasCacheBreakpoint(request: ProxyRequest): boolean {
  return findCacheBreakpoint(request) !== null;
}
