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

const DEFAULT_MAX_ENTRIES = 1_024;
const SWEEP_EVERY_OPERATIONS = 64;

export class TtlCache<K, V> {
  private readonly store = new Map<K, CacheEntry<V>>();
  private operationsSinceSweep = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("TTL must be a positive finite number");
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error("maxEntries must be a positive integer");
  }

  /** Returns the cached value for `key`, or computes and caches it via `loader` on a miss/expiry. */
  get(key: K, loader: () => V): V {
    const now = Date.now();
    this.operationsSinceSweep += 1;
    if (this.operationsSinceSweep >= SWEEP_EVERY_OPERATIONS) {
      this.removeExpired(now);
      this.operationsSinceSweep = 0;
    }

    const hit = this.store.get(key);
    if (hit && hit.expiresAt > now) return hit.value;
    if (hit) this.store.delete(key);

    const value = loader();
    this.store.set(key, { value, expiresAt: now + this.ttlMs });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next();
      if (oldest.done) break;
      this.store.delete(oldest.value);
    }
    return value;
  }

  invalidate(key: K): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
    this.operationsSinceSweep = 0;
  }

  private removeExpired(now: number): void {
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= now) this.store.delete(key);
    }
  }
}
