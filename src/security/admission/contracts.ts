import type { UsageRecord } from "../../transport/canonical-model";
import type { ApiKeyAuthorizationSnapshot, ModelRejectionReason } from "../api-key-auth";

export type AdmissionRejectionReason =
  | "rpm-exhausted"
  | "daily-token-limit"
  | "monthly-token-limit"
  | "lifetime-token-budget"
  | "concurrency-limit"
  | "tenant-capacity-exhausted"
  | "admission-unavailable"
  | ModelRejectionReason;

export interface ApiKeyAdmissionRequest {
  readonly authorization: ApiKeyAuthorizationSnapshot;
  readonly targetProvider: string;
  readonly targetModel: string;
  /** Caller-facing name (alias or combo) the target was resolved from. */
  readonly requestedModel?: string;
  readonly estimatedInputTokens?: number;
  readonly estimatedOutputTokens?: number;
  readonly signal?: AbortSignal;
}

export interface AdmissionReserveRequest {
  readonly reservationId: string;
  readonly apiKeyId: string;
  readonly now: number;
  readonly estimatedTokens: number;
  readonly rpmLimit: number | null;
  readonly dailyLimit: number | null;
  readonly monthlyLimit: number | null;
  readonly lifetimeBudget: number | null;
  readonly lifetimeConsumed: number;
  readonly concurrencyLimit: number | null;
  readonly tenantId: string;
  readonly tenantConcurrencyLimit: number | null;
  /**
   * Fresh persisted `lifetime_tokens_consumed` for the family, read on demand.
   *
   * The seed for `admission:lifetime:<id>` comes from the auth snapshot, which
   * is cached for `AUTH_CACHE_TTL_MS` (~3s) and can therefore understate the
   * true persisted total when another request just committed usage. Once the
   * counter is seeded low it stays that way for its whole TTL — every future
   * INCRBY builds on the wrong baseline. This callback is invoked *only when
   * the store is about to create the counter*, so the fresh value replaces
   * the possibly-stale snapshot value on exactly the write that would freeze
   * the mistake in place. The hot path — an existing counter — never calls
   * it. Optional: without it the caller falls back to `lifetimeConsumed`.
   */
  readonly freshLifetimeConsumed?: () => Promise<number | undefined>;
}

export interface AdmissionLease {
  readonly reservationId: string;
  readonly apiKeyId: string;
  /** Reconciles the provisional reservation exactly once with actual provider usage. */
  commitUsage(usage: UsageRecord): Promise<void>;
  /** Idempotent; releases an uncommitted reservation exactly once. */
  release(): Promise<void>;
  readonly released: boolean;
}

export interface AdmissionCounterStore {
  /** Atomically validates every active limit and creates one idempotent reservation. */
  reserve(request: AdmissionReserveRequest): Promise<void>;
  /** Atomically replaces the reservation estimate with actual tokens and releases concurrency. */
  reconcile(
    apiKeyId: string,
    reserved: number,
    actual: number,
    reservationId: string,
  ): Promise<void>;
  /** Atomically reverses an uncommitted reservation and releases concurrency. */
  release(
    apiKeyId: string,
    reserved: number,
    reservationId: string,
  ): Promise<void>;
  /**
   * Drops all counters and reservations for one key (revocation). Active
   * in-flight reservations are settled first so a later release is a silent
   * no-op instead of an unknown-reservation error; leases in Redis expire
   * via TTL. Best-effort: never throws.
   */
  purge(apiKeyId: string): Promise<void>;
  /**
   * Seeds the daily/monthly counters for the bucket containing `now`, but only
   * when the counter does not exist yet.
   *
   * An operator who adds a daily limit to a key that has already spent today
   * must not be handed a fresh budget on top of that spend. The counters are
   * not persisted anywhere, so the only honest baseline is the usage already
   * recorded for the current bucket. `SETNX`-style: an existing counter is the
   * running total and must never be overwritten. Best-effort and optional —
   * a store without it simply starts the bucket at zero, as before.
   */
  seedBuckets?(request: {
    readonly apiKeyId: string;
    readonly now: number;
    readonly daily?: number;
    readonly monthly?: number;
  }): Promise<void>;
}
