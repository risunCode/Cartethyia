/**
 * Small in-process TTL cache for hot-path config-db reads (API key lookup,
 * access rules, aliases/combos, provider routing/model toggles). Every
 * request on the proxy hot path used to hit `cartethyia.sqlite` directly for
 * these - at high throughput that's tens of thousands of avoidable SQLite
 * reads/sec. A short TTL (default 5s, matching the existing
 * `getRuntimeSettings` cache) keeps admin changes visible quickly while
 * eliminating the read from the common case. Callers should also call
 * `invalidate`/`clear` right after a mutation so admin edits (e.g. revoking
 * a key) take effect immediately rather than waiting out the TTL.
 */

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

export class TtlCache<K, V> {
  private readonly store = new Map<K, CacheEntry<V>>();

  constructor(private readonly ttlMs: number) {}

  /** Returns the cached value for `key`, or computes and caches it via `loader` on a miss/expiry. */
  get(key: K, loader: () => V): V {
    const now = Date.now();
    const hit = this.store.get(key);
    if (hit && hit.expiresAt > now) return hit.value;
    const value = loader();
    this.store.set(key, { value, expiresAt: now + this.ttlMs });
    return value;
  }

  invalidate(key: K): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}
