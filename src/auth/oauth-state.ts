const DEFAULT_STATE_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_STATES = 10_000;

export interface OAuthStateRecord {
  readonly state: string;
  readonly providerId: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly redirectUri: string | null;
  readonly codeVerifier: string | null;
}

export interface OAuthStateOptions {
  readonly ttlMs?: number;
  readonly maxStates?: number;
  readonly nowMs?: () => number;
  readonly randomState?: () => string;
}

/**
 * Bounded, one-time OAuth authorization state. Expired entries are swept on
 * access and the oldest entries are evicted before the hard size cap is
 * exceeded, so an abandoned authorization cannot grow process memory forever.
 */
export class OAuthStateManager {
  private readonly ttlMs: number;
  private readonly maxStates: number;
  private readonly nowMs: () => number;
  private readonly randomState: () => string;
  private readonly states = new Map<string, OAuthStateRecord>();

  constructor(options: OAuthStateOptions = {}) {
    this.ttlMs = Math.max(1, Math.floor(options.ttlMs ?? DEFAULT_STATE_TTL_MS));
    this.maxStates = Math.max(1, Math.floor(options.maxStates ?? DEFAULT_MAX_STATES));
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.randomState = options.randomState ?? (() => crypto.randomUUID());
  }

  create(input: { readonly providerId: string; readonly redirectUri?: string; readonly codeVerifier?: string; readonly state?: string }): OAuthStateRecord {
    const now = this.nowMs();
    this.sweep(now);
    while (this.states.size >= this.maxStates) this.evictOldest();
    const state = input.state && input.state.length > 0 ? input.state : this.randomState();
    const record: OAuthStateRecord = {
      state,
      providerId: input.providerId,
      createdAtMs: now,
      expiresAtMs: now + this.ttlMs,
      redirectUri: input.redirectUri ?? null,
      codeVerifier: input.codeVerifier ?? null,
    };
    this.states.set(state, record);
    return record;
  }

  /** Consumes valid state exactly once; expired or provider-mismatched state is rejected. */
  consume(state: string, providerId: string, nowMs: number = this.nowMs()): OAuthStateRecord | null {
    this.sweep(nowMs);
    const record = this.states.get(state);
    if (record === undefined || record.providerId !== providerId || record.expiresAtMs <= nowMs) {
      if (record !== undefined) this.states.delete(state);
      return null;
    }
    this.states.delete(state);
    return record;
  }

  size(nowMs: number = this.nowMs()): number {
    this.sweep(nowMs);
    return this.states.size;
  }

  clear(): void {
    this.states.clear();
  }

  private sweep(nowMs: number): void {
    for (const [state, record] of this.states) if (record.expiresAtMs <= nowMs) this.states.delete(state);
  }

  private evictOldest(): void {
    let oldest: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [state, record] of this.states) {
      if (record.createdAtMs < oldestAt) {
        oldest = state;
        oldestAt = record.createdAtMs;
      }
    }
    if (oldest !== null) this.states.delete(oldest);
  }
}
