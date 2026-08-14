/**
 * Configuration for a bounded route session state store.
 *
 * Values kept by this store are provider-owned references only. Callers MUST
 * keep prompts, credentials, raw request/response bodies, and other secrets
 * outside the value passed to the store.
 */
export interface RouteSessionStateStoreOptions {
  /** Maximum number of live route entries retained by the store. */
  readonly maxEntries: number;
  /** Idle lifetime in milliseconds; zero expires entries on the next operation. */
  readonly idleTtlMs: number;
  /** Clock used by the store; injectable to make eviction deterministic in tests. */
  readonly now?: () => number;
}

/** Read-only test/diagnostic view of one bounded route session entry. */
export interface RouteSessionStateInspection<T> {
  readonly key: string;
  readonly value: T;
  readonly lastTouchedAtMs: number;
}

type RouteSessionStateEntry<T> = {
  value: T;
  lastTouchedAtMs: number;
  touchOrder: number;
};

type RouteSessionStateReset<T> = string | ((entry: RouteSessionStateInspection<T>) => boolean);

/**
 * In-process bounded state keyed by a caller-supplied route identity.
 *
 * The store expires idle entries before every operation, refreshes recency on
 * get/create/update/touch, and evicts the oldest idle entry at the hard cap.
 * Keys are opaque to the store so callers can compose route affinity,
 * provider, and upstream model identity without this utility knowing provider
 * details.
 */
export class RouteSessionStateStore<T> {
  private readonly entries = new Map<string, RouteSessionStateEntry<T>>();
  private readonly now: () => number;
  private nextTouchOrder = 0;

  constructor(private readonly options: RouteSessionStateStoreOptions) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) {
      throw new RangeError("Route session state maxEntries must be a positive integer");
    }
    if (!Number.isFinite(options.idleTtlMs) || options.idleTtlMs < 0) {
      throw new RangeError("Route session state idleTtlMs must be a finite non-negative number");
    }
    this.now = options.now ?? Date.now;
  }

  /** Number of non-expired route entries currently retained. */
  get size(): number {
    const now = this.readNow();
    this.evictExpired(now);
    return this.entries.size;
  }

  /**
   * Returns and touches a state reference, or undefined when the key is absent
   * or its idle lifetime has elapsed.
   */
  get(key: string): T | undefined {
    const now = this.readNow();
    this.evictExpired(now);
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.touchEntry(key, entry, now);
    return entry.value;
  }

  /** Returns true when a non-expired entry exists, without exposing its value. */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * Returns an existing touched state or creates and stores a new typed state
   * reference. The factory is called only when the key is absent.
   */
  create(key: string, factory: () => T): T {
    const now = this.readNow();
    this.evictExpired(now);
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this.touchEntry(key, existing, now);
      return existing.value;
    }
    const value = factory();
    this.evictForInsert(now);
    this.entries.set(key, { value, lastTouchedAtMs: now, touchOrder: this.nextTouchOrder++ });
    return value;
  }

  /** Alias for callers that prefer an explicit get-or-create name. */
  getOrCreate(key: string, factory: () => T): T {
    return this.create(key, factory);
  }

  /**
   * Updates an existing state reference and touches it. Missing or expired
   * keys return undefined and are never implicitly created.
   */
  update(key: string, update: T | ((current: T) => T)): T | undefined {
    const now = this.readNow();
    this.evictExpired(now);
    const existing = this.entries.get(key);
    if (existing === undefined) return undefined;
    const value = typeof update === "function"
      ? (update as (current: T) => T)(existing.value)
      : update;
    existing.value = value;
    this.touchEntry(key, existing, now);
    return value;
  }

  /** Touches an existing entry without exposing or replacing its value. */
  touch(key: string): boolean {
    const now = this.readNow();
    this.evictExpired(now);
    const entry = this.entries.get(key);
    if (entry === undefined) return false;
    this.touchEntry(key, entry, now);
    return true;
  }

  /** Deletes one route entry and reports whether an entry was removed. */
  delete(key: string): boolean {
    this.evictExpired(this.readNow());
    return this.entries.delete(key);
  }

  /**
   * Explicitly resets one key, all keys, or entries matching a predicate.
   * Returns the number of removed entries so integrations can assert reset
   * behavior without exposing provider payloads.
   */
  reset(selection?: RouteSessionStateReset<T>): number {
    this.evictExpired(this.readNow());
    if (selection === undefined) {
      const removed = this.entries.size;
      this.entries.clear();
      return removed;
    }
    if (typeof selection === "string") return this.entries.delete(selection) ? 1 : 0;
    let removed = 0;
    for (const [key, entry] of this.entries) {
      const inspection: RouteSessionStateInspection<T> = {
        key,
        value: entry.value,
        lastTouchedAtMs: entry.lastTouchedAtMs,
      };
      if (selection(inspection)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Returns a stable oldest-to-newest inspection snapshot for focused tests.
   * The values are typed references; this method never serializes or clones
   * provider state.
   */
  inspect(): readonly RouteSessionStateInspection<T>[] {
    this.evictExpired(this.readNow());
    return Array.from(this.entries, ([key, entry]) => ({
      key,
      value: entry.value,
      lastTouchedAtMs: entry.lastTouchedAtMs,
    }));
  }

  private readNow(): number {
    const now = this.now();
    if (!Number.isFinite(now)) throw new RangeError("Route session state clock must return a finite number");
    return now;
  }

  private evictExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now >= entry.lastTouchedAtMs && now - entry.lastTouchedAtMs >= this.options.idleTtlMs) {
        this.entries.delete(key);
      }
    }
  }

  private evictForInsert(now: number): void {
    this.evictExpired(now);
    while (this.entries.size >= this.options.maxEntries) {
      let oldestKey: string | undefined;
      let oldest: RouteSessionStateEntry<T> | undefined;
      for (const [key, entry] of this.entries) {
        if (oldest === undefined || entry.lastTouchedAtMs < oldest.lastTouchedAtMs || (entry.lastTouchedAtMs === oldest.lastTouchedAtMs && entry.touchOrder < oldest.touchOrder)) {
          oldestKey = key;
          oldest = entry;
        }
      }
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }

  private touchEntry(key: string, entry: RouteSessionStateEntry<T>, now: number): void {
    entry.lastTouchedAtMs = now;
    entry.touchOrder = this.nextTouchOrder++;
    this.entries.delete(key);
    this.entries.set(key, entry);
  }
}
