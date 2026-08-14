import { deriveErrorSource, sanitizeMessage, type ProviderCallError } from "../application/contracts";

/** Default bound for queued requests on a capped provider/model key. */
export const DEFAULT_PROVIDER_CONCURRENCY_MAX_WAITERS = 64;

/** An optional concurrency ceiling; non-positive values mean unlimited. */
export type ProviderConcurrencyLimit = number | null | undefined;

/** Configuration for one provider/model semaphore. */
export interface ProviderConcurrencyConfig {
  readonly limit?: ProviderConcurrencyLimit;
  readonly maxWaiters?: number;
}

/** Registry-wide defaults for provider/model concurrency controls. */
export interface ProviderConcurrencyRegistryOptions extends ProviderConcurrencyConfig {
  readonly limits?: Readonly<Record<string, ProviderConcurrencyLimit | ProviderConcurrencyConfig>>;
}

/** A slot held by one provider request. Releasing a lease more than once is safe. */
export interface ProviderConcurrencyLease {
  readonly key: string;
  release(): Promise<void>;
}

/** Current activity for one provider/model key. */
export interface ProviderConcurrencyMetrics {
  readonly key: string;
  readonly limit: number | null;
  readonly maxWaiters: number;
  readonly active: number;
  readonly waiting: number;
}

interface Waiter {
  readonly resolve: (lease: ProviderConcurrencyLease) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal: AbortSignal | undefined;
  onAbort: (() => void) | null;
  settled: boolean;
}

interface Entry {
  readonly key: string;
  readonly providerId: string;
  readonly modelId: string | null;
  limit: number;
  maxWaiters: number;
  active: number;
  readonly waiters: Waiter[];
}

interface NormalizedConfig {
  readonly limit: number;
  readonly maxWaiters: number;
}

/**
 * Produces the opaque key used by the provider/model registry.
 * Provider and model identifiers are length-prefixed so unusual identifier
 * characters cannot alias another pair.
 */
export function providerModelKey(providerId: string, modelId: string): string {
  return `${providerId.length}:${providerId}${modelId.length}:${modelId}`;
}

/** Backward-friendly alias for callers that name the key after the limiter. */
export const providerConcurrencyKey = providerModelKey;

/**
 * Creates a sanitized typed failure when a capped key cannot accept another
 * waiter. The message intentionally contains no provider/model identifiers.
 */
export function providerConcurrencyExceededError(): ProviderCallError {
  const kind = "concurrency_exceeded" as const;
  return {
    statusCode: 429,
    kind,
    retryable: true,
    routeScope: "provider",
    source: deriveErrorSource(kind, "provider"),
    sanitizedMessage: sanitizeMessage("Provider concurrency wait capacity exceeded"),
    retryAt: null,
  };
}

/**
 * In-process provider/model semaphore registry. A missing or non-positive
 * limit is unlimited, while a positive limit queues at most `maxWaiters`
 * requests before returning a typed concurrency error.
 */
export class ProviderConcurrencyRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly configurations = new Map<string, NormalizedConfig>();
  private readonly defaultConfig: NormalizedConfig;

  constructor(options: ProviderConcurrencyRegistryOptions = {}) {
    this.defaultConfig = normalizeConfig(options);
    for (const [key, value] of Object.entries(options.limits ?? {})) {
      this.configurations.set(key, normalizeConfig(value));
    }
  }

  /** Registers a key or a provider/model pair without replacing active entries. */
  configure(key: string, config: ProviderConcurrencyLimit | ProviderConcurrencyConfig): void;
  configure(providerId: string, modelId: string, config: ProviderConcurrencyLimit | ProviderConcurrencyConfig): void;
  configure(
    keyOrProviderId: string,
    configOrModelId: string | ProviderConcurrencyLimit | ProviderConcurrencyConfig,
    maybeConfig?: ProviderConcurrencyLimit | ProviderConcurrencyConfig,
  ): void {
    const key = typeof configOrModelId === "string"
      ? providerModelKey(keyOrProviderId, configOrModelId)
      : keyOrProviderId;
    const rawConfig = typeof configOrModelId === "string" ? maybeConfig : configOrModelId;
    this.configurations.set(key, normalizeConfig(rawConfig));
    this.refreshEntries(key);
  }

  /** Configures a provider-wide fallback used when no model-specific value exists. */
  configureProvider(providerId: string, config: ProviderConcurrencyLimit | ProviderConcurrencyConfig): void {
    this.configure(providerId, config);
  }

  /** Configures one provider/model key using explicit positional arguments. */
  setLimit(providerId: string, modelId: string, limit: ProviderConcurrencyLimit, maxWaiters?: number): void {
    this.configure(providerId, modelId, { limit, maxWaiters });
  }

  /** Removes a key/provider configuration and restores the applicable default. */
  clearConfiguration(key: string): void {
    this.configurations.delete(key);
    this.refreshEntries(key);
  }

  /**
   * Acquires a provider/model slot. The two-argument form accepts an opaque
   * key and optional signal; the three-argument form accepts provider/model
   * identifiers and an optional caller signal.
   */
  acquire(key: string, signal?: AbortSignal): Promise<ProviderConcurrencyLease>;
  acquire(providerId: string, modelId: string, signal?: AbortSignal): Promise<ProviderConcurrencyLease>;
  acquire(keyOrProviderId: string, modelOrSignal?: string | AbortSignal, maybeSignal?: AbortSignal): Promise<ProviderConcurrencyLease> {
    if (typeof modelOrSignal === "string") {
      const key = providerModelKey(keyOrProviderId, modelOrSignal);
      return this.acquirePair(key, keyOrProviderId, modelOrSignal, maybeSignal);
    }
    return this.acquirePair(keyOrProviderId, keyOrProviderId, null, modelOrSignal);
  }

  /** Acquires a slot by an already-created opaque key. */
  acquireKey(key: string, signal?: AbortSignal): Promise<ProviderConcurrencyLease> {
    return this.acquirePair(key, key, null, signal);
  }

  /** Returns current metrics for a key or provider/model pair. */
  getMetrics(key: string): ProviderConcurrencyMetrics;
  getMetrics(providerId: string, modelId: string): ProviderConcurrencyMetrics;
  getMetrics(keyOrProviderId: string, modelId?: string): ProviderConcurrencyMetrics {
    const key = modelId === undefined ? keyOrProviderId : providerModelKey(keyOrProviderId, modelId);
    const entry = this.entries.get(key);
    if (entry === undefined) {
      const config = this.resolveConfig(key, modelId === undefined ? keyOrProviderId : keyOrProviderId);
      return { key, limit: toPublicLimit(config.limit), maxWaiters: config.maxWaiters, active: 0, waiting: 0 };
    }
    return toMetrics(entry);
  }

  /** Alias for callers that use a shorter metrics verb. */
  metrics(key: string): ProviderConcurrencyMetrics;
  metrics(providerId: string, modelId: string): ProviderConcurrencyMetrics;
  metrics(keyOrProviderId: string, modelId?: string): ProviderConcurrencyMetrics {
    return modelId === undefined ? this.getMetrics(keyOrProviderId) : this.getMetrics(keyOrProviderId, modelId);
  }

  /** Returns all keys that have been observed or configured, sorted stably. */
  getAllMetrics(): readonly ProviderConcurrencyMetrics[] {
    const keys = new Set<string>([...this.entries.keys(), ...this.configurations.keys()]);
    return [...keys].sort().map((key) => this.getMetrics(key));
  }

  /** Returns the active count for a key or provider/model pair. */
  activeCount(key: string): number;
  activeCount(providerId: string, modelId: string): number;
  activeCount(keyOrProviderId: string, modelId?: string): number {
    return modelId === undefined ? this.getMetrics(keyOrProviderId).active : this.getMetrics(keyOrProviderId, modelId).active;
  }

  /** Returns the queued count for a key or provider/model pair. */
  waitingCount(key: string): number;
  waitingCount(providerId: string, modelId: string): number;
  waitingCount(keyOrProviderId: string, modelId?: string): number {
    return modelId === undefined ? this.getMetrics(keyOrProviderId).waiting : this.getMetrics(keyOrProviderId, modelId).waiting;
  }

  /** Test/support reset that cancels queued waiters and drops all state. */
  reset(): void {
    const resetError = new Error("Provider concurrency registry reset");
    for (const entry of this.entries.values()) {
      for (const waiter of entry.waiters.splice(0)) {
        waiter.settled = true;
        if (waiter.onAbort !== null && waiter.signal !== undefined) waiter.signal.removeEventListener("abort", waiter.onAbort);
        waiter.onAbort = null;
        waiter.reject(resetError);
      }
    }
    this.entries.clear();
    this.configurations.clear();
  }

  private acquirePair(key: string, providerId: string, modelId: string | null, signal?: AbortSignal): Promise<ProviderConcurrencyLease> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const entry = this.entryFor(key, providerId, modelId);
    if (entry.active < entry.limit) {
      entry.active += 1;
      return Promise.resolve(this.createLease(entry));
    }
    if (entry.waiters.length >= entry.maxWaiters) return Promise.reject(providerConcurrencyExceededError());
    const pending = Promise.withResolvers<ProviderConcurrencyLease>();
    const waiter: Waiter = {
      resolve: pending.resolve,
      reject: pending.reject,
      signal,
      onAbort: null,
      settled: false,
    };
    if (signal !== undefined) {
      const onAbort = () => {
        if (waiter.settled) return;
        const index = entry.waiters.indexOf(waiter);
        if (index < 0) return;
        entry.waiters.splice(index, 1);
        waiter.settled = true;
        waiter.onAbort = null;
        signal.removeEventListener("abort", onAbort);
        waiter.reject(abortReason(signal));
      };
      waiter.onAbort = onAbort;
      signal.addEventListener("abort", onAbort, { once: true });
    }
    entry.waiters.push(waiter);
    return pending.promise;
  }

  private createLease(entry: Entry): ProviderConcurrencyLease {
    let released = false;
    return {
      key: entry.key,
      release: async () => {
        if (released) return;
        released = true;
        if (entry.active > 0) entry.active -= 1;
        this.drain(entry);
      },
    };
  }

  private drain(entry: Entry): void {
    while (entry.active < entry.limit && entry.waiters.length > 0) {
      const waiter = entry.waiters.shift();
      if (waiter === undefined || waiter.settled) continue;
      waiter.settled = true;
      if (waiter.onAbort !== null && waiter.signal !== undefined) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.onAbort = null;
      entry.active += 1;
      waiter.resolve(this.createLease(entry));
    }
  }

  private entryFor(key: string, providerId: string, modelId: string | null): Entry {
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this.applyConfig(existing, this.resolveConfig(key, providerId));
      return existing;
    }
    const config = this.resolveConfig(key, providerId);
    const entry: Entry = { key, providerId, modelId, limit: config.limit, maxWaiters: config.maxWaiters, active: 0, waiters: [] };
    this.entries.set(key, entry);
    return entry;
  }

  private resolveConfig(key: string, providerId: string): NormalizedConfig {
    return this.configurations.get(key) ?? this.configurations.get(providerId) ?? this.defaultConfig;
  }

  private applyConfig(entry: Entry, config: NormalizedConfig): void {
    entry.limit = config.limit;
    entry.maxWaiters = config.maxWaiters;
    this.drain(entry);
  }

  private refreshEntries(configurationKey: string): void {
    for (const entry of this.entries.values()) {
      if (entry.key === configurationKey || entry.providerId === configurationKey) {
        this.applyConfig(entry, this.resolveConfig(entry.key, entry.providerId));
      }
    }
  }
}

/** Shared request-path registry. It remains unlimited until configured. */
export const providerConcurrencyRegistry = new ProviderConcurrencyRegistry();

/** Configures the shared request-path registry for one provider/model pair. */
export function configureProviderConcurrency(
  providerId: string,
  modelId: string,
  config: ProviderConcurrencyLimit | ProviderConcurrencyConfig,
): void {
  providerConcurrencyRegistry.configure(providerId, modelId, config);
}

/** Test-only reset for the shared request-path registry. */
export function resetProviderConcurrencyForTests(): void {
  providerConcurrencyRegistry.reset();
}

function normalizeConfig(value: ProviderConcurrencyLimit | ProviderConcurrencyConfig = {}): NormalizedConfig {
  const rawLimit = typeof value === "object" && value !== null ? value.limit : value;
  const rawWaiters = typeof value === "object" && value !== null ? value.maxWaiters : undefined;
  const limit = typeof rawLimit === "number" && Number.isFinite(rawLimit) && Math.trunc(rawLimit) > 0 ? Math.trunc(rawLimit) : Number.POSITIVE_INFINITY;
  const maxWaiters = rawWaiters === undefined
    ? DEFAULT_PROVIDER_CONCURRENCY_MAX_WAITERS
    : typeof rawWaiters === "number" && Number.isFinite(rawWaiters)
      ? Math.max(0, Math.min(10_000, Math.trunc(rawWaiters)))
      : DEFAULT_PROVIDER_CONCURRENCY_MAX_WAITERS;
  return { limit, maxWaiters };
}

function toPublicLimit(limit: number): number | null {
  return limit === Number.POSITIVE_INFINITY ? null : limit;
}

function toMetrics(entry: Entry): ProviderConcurrencyMetrics {
  return { key: entry.key, limit: toPublicLimit(entry.limit), maxWaiters: entry.maxWaiters, active: entry.active, waiting: entry.waiters.length };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Provider concurrency acquire aborted");
}
