// Cache TTL per endpoint (in milliseconds)
const CACHE_TTL: Record<string, number> = {
  '/api/dashboard/summary': 5000, // 5s
  '/api/dashboard/usage': 30000, // 30s
  '/api/dashboard/providers': 60000, // 60s
  '/api/dashboard/quota': 30000, // 30s
  '/api/dashboard/console/history': 60000, // 60s
  '/api/dashboard/settings': 300000, // 5min
  '/api/share': 60000, // 60s
}

interface CacheEntry<T> {
  data: T
  timestamp: number
  ttl: number
}

class APICache {
  private cache = new Map<string, CacheEntry<unknown>>()

  // Get cached data if valid
  get<T>(key: string): T | null {
    const entry = this.cache.get(key)
    if (!entry) return null

    const now = Date.now()
    if (now - entry.timestamp > entry.ttl) {
      this.cache.delete(key)
      return null
    }

    return entry.data as T
  }

  // Set cached data with TTL
  set<T>(key: string, data: T, ttl?: number): void {
    const cacheTTL = ttl || this.getTTLForEndpoint(key)
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl: cacheTTL,
    })
  }

  // Invalidate specific cache entry
  invalidate(key: string): void {
    this.cache.delete(key)
  }

  // Invalidate all cache entries matching a pattern
  invalidatePattern(pattern: string): void {
    const regex = new RegExp(pattern)
    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        this.cache.delete(key)
      }
    }
  }

  // Clear all cache
  clear(): void {
    this.cache.clear()
  }

  // Get TTL for endpoint from configuration
  private getTTLForEndpoint(endpoint: string): number {
    for (const [pattern, ttl] of Object.entries(CACHE_TTL)) {
      if (endpoint.startsWith(pattern)) {
        return ttl
      }
    }
    return 60000 // Default 60s
  }

  // Get cache size (for monitoring)
  size(): number {
    return this.cache.size
  }

  // Get cache stats (for monitoring)
  getStats(): { size: number; entries: Array<{ key: string; age: number; ttl: number }> } {
    const now = Date.now()
    const entries = Array.from(this.cache.entries()).map(([key, entry]) => ({
      key,
      age: now - entry.timestamp,
      ttl: entry.ttl,
    }))
    return {
      size: this.cache.size,
      entries,
    }
  }
}

// Singleton instance
export const apiCache = new APICache()

// Helper function to get cache key from URL and params
export function getCacheKey(url: string, params?: Record<string, string | number | boolean>): string {
  if (!params) return url
  const queryString = new URLSearchParams(
    Object.fromEntries(
      Object.entries(params).map(([k, v]) => [k, String(v)])
    )
  ).toString()
  return queryString ? `${url}?${queryString}` : url
}
