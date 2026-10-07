import { dedupeRequest } from "../network/deduplication";
/**
 * Bounded TTL cache with automatic eviction.
 *
 * - Time-based expiration (TTL)
 * - Maximum entry cap with oldest-first eviction
 * - Revision-aware key invalidation
 */

export interface TtlCacheOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

export interface TtlCacheEntry<T> {
  readonly value: T;
  readonly at: number;
}

/**
 * A bounded TTL cache that automatically evicts expired entries
 * and enforces a maximum entry count by evicting oldest entries.
 */
export class TtlCache<T> {
  private readonly cache = new Map<string, TtlCacheEntry<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: TtlCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 5_000;
    this.maxEntries = opts.maxEntries ?? 128;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Get a cached value if it exists and hasn't expired.
   */
  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    const now = this.now();
    if (now - entry.at >= this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /**
   * Set a value in the cache with the current timestamp.
   * Evicts expired entries and enforces max entry count.
   */
  set(key: string, value: T): void {
    const now = this.now();
    this.cache.set(key, { value, at: now });
    this.evictIfNeeded(now);
  }

  /**
   * Delete a specific key.
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Load-through read: returns a fresh value when absent or expired. A
   * `shouldCache` result of false skips the write so failures stay retryable.
   * Concurrent misses share one in-flight load per instance via `dedupeRequest`.
   */
  async load(
    key: string,
    loader: () => Promise<T | null | undefined>,
    options: {
      readonly namespace?: string;
      readonly shouldCache?: (value: T) => boolean;
    } = {},
  ): Promise<T | null> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = await dedupeRequest(`${options.namespace ?? "ttl-cache"}:${key}`, loader);
    if (value !== null && value !== undefined && (options.shouldCache?.(value) ?? true)) {
      this.set(key, value);
    }
    return value ?? null;
  }

  /**
   * Keys iterator.
   */
  keys(): IterableIterator<string> {
    return this.cache.keys();
  }
  /**
   * Get the current number of entries.
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Evict expired entries and enforce max entry count.
   */
  private evictIfNeeded(now: number): void {
    if (this.cache.size <= this.maxEntries) return;

    // First pass: evict expired entries
    for (const [k, v] of this.cache) {
      if (now - v.at >= this.ttlMs) {
        this.cache.delete(k);
      }
    }

    // Second pass: evict oldest entries until under cap
    // TTL sweep alone cannot bound cardinality under sustained load — many
    // tenants can all be within the TTL window at once. Evict oldest
    // insertion-order entries until back under the cap so `cache.size` is
    // a hard ceiling, not just a sweep trigger.
    while (this.cache.size > this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) break;
      this.cache.delete(oldestKey);
    }
  }
}

/** One TTL-sized cache inside a {@link TtlCacheFamily}. */
export interface TtlCacheFamilyOptions {
  /** TTL applied when a caller does not pass its own. */
  readonly defaultTtlMs: number;
  /** Entry cap per TTL-sized cache. */
  readonly maxEntries?: number;
}

/**
 * A set of {@link TtlCache} instances keyed by TTL, created on first use.
 *
 * Two provider-side caches (`operations/provider-version-cache.ts` and
 * `operations/model-discovery-cache.ts`) had each hand-rolled the same
 * `Map<number, TtlCache<T>>` + `cacheFor(ttlMs)` memo plus the same
 * `for (const cache of caches.values()) cache.clear()` reset. Tests pass
 * `ttlMs: 0` to force a reload, which is why the per-TTL split exists at all —
 * it keeps a test's zero TTL from mutating the default cache.
 *
 * The TTL becomes part of the cache identity, so a caller passing its own
 * `ttlMs` gets its own cache rather than silently retuning the shared one.
 */
export class TtlCacheFamily<T> {
  readonly #defaultTtlMs: number;
  readonly #maxEntries: number;
  readonly #caches = new Map<number, TtlCache<T>>();

  constructor(options: TtlCacheFamilyOptions) {
    this.#defaultTtlMs = options.defaultTtlMs;
    this.#maxEntries = options.maxEntries ?? 256;
  }

  /** The cache for `ttlMs`, or for the family default when it is omitted. */
  for(ttlMs?: number): TtlCache<T> {
    const key = ttlMs ?? this.#defaultTtlMs;
    const existing = this.#caches.get(key);
    if (existing) return existing;
    const created = new TtlCache<T>({ ttlMs: key, maxEntries: this.#maxEntries });
    this.#caches.set(key, created);
    return created;
  }

  /** Drops every cached value across every TTL. Test-only. */
  clear(): void {
    for (const cache of this.#caches.values()) cache.clear();
  }
}
