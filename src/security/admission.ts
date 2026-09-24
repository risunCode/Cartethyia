import { GatewayError } from "../transport/gateway-error";
import type { UsageRecord } from "../transport/canonical-model";
import { redisEvalNumber, type RedisClient } from "../persistence/redis";
import {
  type ApiKeyAuthorizationSnapshot,
  type ModelRejectionReason,
  getAdmissionIdentity,
  isProviderAllowed,
  modelRejectionReason,
} from "./api-key-auth";
import { metrics } from "../observability/metrics";
import { log } from "../observability/logger";

export type AdmissionRejectionReason =
  | "rpm-exhausted"
  | "daily-token-limit"
  | "monthly-token-limit"
  | "lifetime-token-budget"
  | "concurrency-limit"
  | "tenant-capacity-exhausted"
  | "provider-not-allowed"
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
}

interface InMemoryReservation {
  readonly apiKeyId: string;
  readonly reserved: number;
  readonly tracksDaily: boolean;
  readonly tracksMonthly: boolean;
  /**
   * Bucket-qualified counter keys this reservation wrote to, captured at
   * reserve time. The Redis store records the same two keys inside its lease
   * hash (see `RESERVE_SCRIPT`) so a commit or release settles the bucket the
   * reservation actually charged — not whatever bucket is current when the
   * request finishes. Without this, a reservation admitted at 23:59 would
   * release against the next day's counter and corrupt it.
   */
  readonly dailyKey: string;
  readonly monthlyKey: string;
  readonly tracksLifetime: boolean;
  readonly tracksConcurrency: boolean;
  readonly tenantId: string;
  readonly tracksTenantConcurrency: boolean;
  state: "active" | "committed" | "released";
}

/**
 * Bucket-qualified counter key. Daily and monthly budgets must roll over on
 * the calendar boundary rather than accumulating forever, so the bucket is
 * part of the key — exactly as the Redis store builds
 * `admission:daily:<apiKeyId>:<YYYY-MM-DD>`.
 */
function bucketKey(apiKeyId: string, bucket: string): string {
  return `${apiKeyId}:${bucket}`;
}

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && Number.isInteger(value);
}

/**
 * Single source of truth for an admission rejection reason: the operator-facing
 * message, the canonical GatewayError code and status, and the telemetry label.
 *
 * Module-level and read-only. The three tables this replaces were rebuilt as
 * fresh object literals on every rejection, which is the hot path for a
 * throttled tenant.
 */
const REASON_META: Record<
  AdmissionRejectionReason,
  {
    readonly message: string;
    readonly code: GatewayError["code"];
    readonly status: number;
    readonly metricLabel: string;
  }
> = {
  "rpm-exhausted": {
    message: "rpm limit exceeded",
    code: "quota_exceeded",
    status: 429,
    metricLabel: "rpm_exhausted",
  },
  "daily-token-limit": {
    message: "daily token limit exceeded",
    code: "quota_exceeded",
    status: 429,
    metricLabel: "daily",
  },
  "monthly-token-limit": {
    message: "monthly token limit exceeded",
    code: "quota_exceeded",
    status: 429,
    metricLabel: "monthly",
  },
  "lifetime-token-budget": {
    message: "lifetime token budget exceeded",
    code: "quota_exceeded",
    status: 429,
    metricLabel: "lifetime",
  },
  "concurrency-limit": {
    message: "concurrency limit exceeded",
    code: "capacity_exhausted",
    status: 429,
    metricLabel: "concurrency",
  },
  "tenant-capacity-exhausted": {
    message: "tenant concurrency limit exceeded",
    code: "tenant_capacity_exhausted",
    status: 429,
    metricLabel: "tenant_capacity",
  },
  "provider-not-allowed": {
    message: "model or provider not allowed",
    code: "model_not_found",
    status: 404,
    metricLabel: "provider_not_allowed",
  },
  "model-not-allowed": {
    message: "model or provider not allowed",
    code: "model_not_found",
    status: 404,
    metricLabel: "model_not_allowed",
  },
  "model-denied": {
    message: "model or provider not allowed",
    code: "model_not_found",
    status: 404,
    metricLabel: "model_not_allowed",
  },
  "admission-unavailable": {
    message: "admission store unavailable",
    code: "admission_unavailable",
    status: 503,
    metricLabel: "admission_unavailable",
  },
};

function reasonToGatewayError(
  reason: AdmissionRejectionReason,
  detail: Record<string, unknown> = {},
): GatewayError {
  const meta = REASON_META[reason];
  return new GatewayError(meta.code, meta.status, meta.message, { reason, ...detail });
}

/**
 * Derives the telemetry metric label from the rejection reason. Unknown reasons
 * fall back to `admission_unavailable` so a new reason cannot emit an unbounded
 * metric label before its row is filled in.
 */
function admissionMetricLabel(reason: AdmissionRejectionReason | string): string {
  return (
    REASON_META[reason as AdmissionRejectionReason]?.metricLabel ?? "admission_unavailable"
  );
}

function knownTokens(value: number | "unavailable" | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function usageTokens(usage: UsageRecord): number {
  return (
    knownTokens(usage.input_tokens) +
    knownTokens(usage.output_tokens) +
    knownTokens(usage.cache_write_tokens) +
    knownTokens(usage.reasoning_tokens)
  );
}



/**
 * Hard cap on terminal (committed/released) reservations kept for idempotency.
 * Oldest entries are evicted when the ring is full. This prevents unbounded
 * memory growth in single-instance mode while preserving replay idempotency
 * for recently finalized reservations.
 */
const TERMINAL_RESERVATION_CAP = 10_000;

/** Atomic single-process admission store used by tests and single-process development. */
export class InMemoryAdmissionCounterStore implements AdmissionCounterStore {
  private readonly rpmTimestamps = new Map<string, number[]>();
  private readonly daily = new Map<string, number>();
  private readonly monthly = new Map<string, number>();
  private readonly lifetime = new Map<string, number>();
  private readonly concurrent = new Map<string, number>();
  private readonly tenantConcurrent = new Map<string, number>();
  private readonly reservations = new Map<string, InMemoryReservation>();
  private readonly terminalRing: string[] = []; // Ring buffer for terminal reservation IDs
  private failing = false;
  private gate: Promise<void> = Promise.resolve();

  constructor(private readonly options: { readonly windowMs?: number } = {}) {}

  simulateFailure(failing: boolean): void {
    this.failing = failing;
  }

  /**
   * Reads the daily counter for the bucket containing `now`. The bucket is
   * part of the counter's identity, so the reader must say when it is asking;
   * this is in-memory-only introspection, not part of the store contract.
   */
  async getDailyTokens(apiKeyId: string, now = Date.now()): Promise<number> {
    return this.exclusive(() => this.value(this.daily, bucketKey(apiKeyId, dailyBucket(now))));
  }

  /** Reads the monthly counter for the bucket containing `now`. */
  async getMonthlyTokens(apiKeyId: string, now = Date.now()): Promise<number> {
    return this.exclusive(() =>
      this.value(this.monthly, bucketKey(apiKeyId, monthlyBucket(now))),
    );
  }

  async getConcurrent(apiKeyId: string): Promise<number> {
    return this.exclusive(() => this.value(this.concurrent, apiKeyId));
  }

  async reserve(request: AdmissionReserveRequest): Promise<void> {
    await this.exclusive(() => {
      this.assertAvailable();
      const existing = this.reservations.get(request.reservationId);
      if (existing) {
        if (
          existing.state === "active" ||
          existing.state === "committed" ||
          existing.state === "released"
        )
          return;
      }
      if (
        !finiteNonNegative(request.estimatedTokens) ||
        !finiteNonNegative(request.lifetimeConsumed)
      ) {
        throw reasonToGatewayError("admission-unavailable", { reason: "invalid_counter" });
      }
      const rpm = this.pruneRpm(request.apiKeyId, request.now);
      const dailyKey = bucketKey(request.apiKeyId, dailyBucket(request.now));
      const monthlyKey = bucketKey(request.apiKeyId, monthlyBucket(request.now));
      const daily = this.value(this.daily, dailyKey);
      const monthly = this.value(this.monthly, monthlyKey);
      const concurrent = this.value(this.concurrent, request.apiKeyId);
      const tenantConcurrent = this.value(this.tenantConcurrent, request.tenantId);
      const lifetime = this.lifetime.get(request.apiKeyId) ?? request.lifetimeConsumed;
      if (
        !finiteNonNegative(daily) ||
        !finiteNonNegative(monthly) ||
        !finiteNonNegative(concurrent) ||
        !finiteNonNegative(tenantConcurrent) ||
        !finiteNonNegative(lifetime)
      ) {
        throw reasonToGatewayError("admission-unavailable", { reason: "corrupt_counter" });
      }
      if (request.rpmLimit != null && rpm.length >= request.rpmLimit)
        throw reasonToGatewayError("rpm-exhausted", { limit: request.rpmLimit });
      if (request.dailyLimit != null && daily + request.estimatedTokens > request.dailyLimit)
        throw reasonToGatewayError("daily-token-limit", { limit: request.dailyLimit });
      if (request.monthlyLimit != null && monthly + request.estimatedTokens > request.monthlyLimit)
        throw reasonToGatewayError("monthly-token-limit", { limit: request.monthlyLimit });
      if (
        request.lifetimeBudget != null &&
        lifetime + request.estimatedTokens > request.lifetimeBudget
      )
        throw reasonToGatewayError("lifetime-token-budget", { limit: request.lifetimeBudget });
      if (request.concurrencyLimit != null && concurrent >= request.concurrencyLimit)
        throw reasonToGatewayError("concurrency-limit", { limit: request.concurrencyLimit });
      if (
        request.tenantConcurrencyLimit != null &&
        tenantConcurrent >= request.tenantConcurrencyLimit
      )
        throw reasonToGatewayError("tenant-capacity-exhausted", { limit: request.tenantConcurrencyLimit });
      if (request.rpmLimit != null) rpm.push(request.now);
      if (request.dailyLimit != null)
        this.daily.set(dailyKey, daily + request.estimatedTokens);
      if (request.monthlyLimit != null)
        this.monthly.set(monthlyKey, monthly + request.estimatedTokens);
      if (request.lifetimeBudget != null)
        this.lifetime.set(request.apiKeyId, lifetime + request.estimatedTokens);
      if (request.concurrencyLimit != null) this.concurrent.set(request.apiKeyId, concurrent + 1);
      if (request.tenantConcurrencyLimit != null)
        this.tenantConcurrent.set(request.tenantId, tenantConcurrent + 1);
      this.reservations.set(request.reservationId, {
        apiKeyId: request.apiKeyId,
        reserved: request.estimatedTokens,
        tracksDaily: request.dailyLimit != null,
        tracksMonthly: request.monthlyLimit != null,
        dailyKey,
        monthlyKey,
        tracksLifetime: request.lifetimeBudget != null,
        tracksConcurrency: request.concurrencyLimit != null,
        tenantId: request.tenantId,
        tracksTenantConcurrency: request.tenantConcurrencyLimit != null,
        state: "active",
      });
    });
  }

  async reconcile(
    apiKeyId: string,
    reserved: number,
    actual: number,
    reservationId: string,
  ): Promise<void> {
    await this.exclusive(() => {
      this.assertAvailable();
      const reservation = this.requireReservation(apiKeyId, reserved, reservationId);
      if (reservation.state !== "active") return;
      if (!finiteNonNegative(actual))
        throw reasonToGatewayError("admission-unavailable", { reason: "invalid_actual_usage" });
      const delta = actual - reservation.reserved;
      this.adjust(this.daily, reservation.dailyKey, delta, reservation.tracksDaily);
      this.adjust(this.monthly, reservation.monthlyKey, delta, reservation.tracksMonthly);
      this.adjust(this.lifetime, apiKeyId, delta, reservation.tracksLifetime);
      if (reservation.tracksConcurrency) this.decrement(this.concurrent, apiKeyId);
      if (reservation.tracksTenantConcurrency)
        this.decrement(this.tenantConcurrent, reservation.tenantId);
      reservation.state = "committed";
      this.addToTerminalRing(reservationId);
    });
  }

  async release(
    apiKeyId: string,
    reserved: number,
    reservationId: string,
  ): Promise<void> {
    await this.exclusive(() => {
      this.assertAvailable();
      const reservation = this.requireReservation(apiKeyId, reserved, reservationId);
      if (reservation.state !== "active") return;
      this.settleReservation(reservation);
      this.addToTerminalRing(reservationId);
    });
  }

  /**
   * Drops every counter and reservation for one key. Active reservations
   * settle through the normal accounting path first, so a later release
   * for an in-flight request is a silent no-op instead of corrupting
   * zeroed counters or throwing unknown-reservation.
   */
  async purge(apiKeyId: string): Promise<void> {
    await this.exclusive(() => {
      for (const [reservationId, reservation] of this.reservations) {
        if (reservation.apiKeyId !== apiKeyId || reservation.state !== "active") continue;
        this.settleReservation(reservation);
        this.addToTerminalRing(reservationId);
      }
      this.rpmTimestamps.delete(apiKeyId);
      // Daily and monthly counters are bucket-qualified, so revoking one key
      // must drop every bucket it has accrued, not a single keyed entry.
      this.deleteKeyPrefix(this.daily, apiKeyId);
      this.deleteKeyPrefix(this.monthly, apiKeyId);
      this.lifetime.delete(apiKeyId);
      this.concurrent.delete(apiKeyId);
    });
  }

  /** Drops every entry whose key is `<apiKeyId>:<bucket>`. */
  private deleteKeyPrefix(store: Map<string, number>, apiKeyId: string): void {
    const prefix = `${apiKeyId}:`;
    for (const key of store.keys()) {
      if (key.startsWith(prefix)) store.delete(key);
    }
  }

  /** Applies release accounting to an active reservation and retires it. */
  private settleReservation(reservation: InMemoryReservation): void {
    this.adjust(this.daily, reservation.dailyKey, -reservation.reserved, reservation.tracksDaily);
    this.adjust(this.monthly, reservation.monthlyKey, -reservation.reserved, reservation.tracksMonthly);
    this.adjust(this.lifetime, reservation.apiKeyId, -reservation.reserved, reservation.tracksLifetime);
    if (reservation.tracksConcurrency) this.decrement(this.concurrent, reservation.apiKeyId);
    if (reservation.tracksTenantConcurrency)
      this.decrement(this.tenantConcurrent, reservation.tenantId);
    reservation.state = "released";
  }

  private async exclusive<T>(operation: () => T): Promise<T> {
    const prior = this.gate;
    let release!: () => void;
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return operation();
    } finally {
      release();
    }
  }

  private assertAvailable(): void {
    if (this.failing) throw new Error("store unavailable");
  }
  private value(store: ReadonlyMap<string, number>, key: string): number {
    return store.get(key) ?? 0;
  }
  private pruneRpm(apiKeyId: string, now: number): number[] {
    const cutoff = now - (this.options.windowMs ?? 60_000);
    const kept = (this.rpmTimestamps.get(apiKeyId) ?? []).filter((timestamp) => timestamp > cutoff);
    this.rpmTimestamps.set(apiKeyId, kept);
    return kept;
  }
  private requireReservation(
    apiKeyId: string,
    reserved: number,
    reservationId: string,
  ): InMemoryReservation {
    const reservation = this.reservations.get(reservationId);
    if (!reservation || reservation.apiKeyId !== apiKeyId || reservation.reserved !== reserved) {
      throw reasonToGatewayError("admission-unavailable", { reason: "unknown_reservation" });
    }
    return reservation;
  }

  /**
   * Adds a terminal (committed/released) reservation to the ring buffer.
   * If the ring is full, evicts the oldest terminal reservation to prevent
   * unbounded memory growth while preserving idempotency for recent operations.
   */
  private addToTerminalRing(reservationId: string): void {
    this.terminalRing.push(reservationId);
    if (this.terminalRing.length > TERMINAL_RESERVATION_CAP) {
      const oldestId = this.terminalRing.shift();
      if (oldestId) {
        const oldest = this.reservations.get(oldestId);
        // Only evict if it's still terminal (active reservations stay)
        if (oldest && (oldest.state === "committed" || oldest.state === "released")) {
          this.reservations.delete(oldestId);
        }
      }
    }
  }
  private adjust(store: Map<string, number>, key: string, delta: number, enabled: boolean): void {
    if (!enabled) return;
    const next = this.value(store, key) + delta;
    if (!finiteNonNegative(next))
      throw reasonToGatewayError("admission-unavailable", { reason: "corrupt_counter" });
    store.set(key, next);
  }
  private decrement(store: Map<string, number>, key: string): void {
    const next = this.value(store, key) - 1;
    if (!finiteNonNegative(next))
      throw reasonToGatewayError("admission-unavailable", { reason: "corrupt_counter" });
    store.set(key, next);
  }
}

/** Persists reconciled lifetime token consumption for an API key. Injected so
 *  the in-memory admission service stays decoupled from Drizzle/Postgres. */
export type LifetimeUsagePersister = (input: {
  apiKeyId: string;
  delta: number;
}) => Promise<void>;

/** Performs one atomic pre-dispatch admission and returns an idempotent attempt lease. */
export class ApiKeyAdmissionService {
  constructor(
    private readonly store: AdmissionCounterStore,
    private readonly clock: () => number = () => Date.now(),
    private readonly tenantConcurrencyProvider: (
      tenantId: string,
    ) => Promise<number | null> | number | null = () => null,
    private readonly persistLifetimeUsage?: LifetimeUsagePersister,
  ) {
    if (!store) throw new Error("ApiKeyAdmissionService requires an admission store");
  }

  /**
   * Drops all admission state for one key (revocation). Best-effort: a
   * recycled key id must never inherit RPM/token/concurrency history.
   */
  async purgeKey(apiKeyId: string): Promise<void> {
    await this.store.purge(apiKeyId).catch(() => undefined);
  }

  async admit(input: ApiKeyAdmissionRequest): Promise<AdmissionLease> {
    const reject = (reason: AdmissionRejectionReason, detail: Record<string, unknown>): never => {
      metrics.proxy_admission_total.inc(1, { reason: admissionMetricLabel(reason) });
      throw reasonToGatewayError(reason, detail);
    };

    if (input.signal?.aborted) reject("admission-unavailable", { reason: "aborted" });

    const snapshot = input.authorization;
    if (!snapshot) reject("admission-unavailable", { reason: "missing_snapshot" });

    const apiKeyId = getAdmissionIdentity(snapshot);
    if (!apiKeyId || !snapshot.tenant_id) {
      reject("admission-unavailable", { reason: "missing_snapshot" });
    }
    if (!isProviderAllowed(snapshot, input.targetProvider)) {
      reject("provider-not-allowed", { provider: input.targetProvider });
    }
    const rejected = modelRejectionReason(
      snapshot,
      input.targetModel,
      input.targetProvider,
      input.requestedModel,
    );
    if (rejected) {
      reject(rejected, { model: input.targetModel });
    }

    const estimatedTokens = Math.max(
      0,
      Math.floor((input.estimatedInputTokens ?? 0) + (input.estimatedOutputTokens ?? 0)),
    );
    const now = this.clock();
    const reservationId = `${apiKeyId}:${now}:${crypto.randomUUID()}`;
    const rawTenantLimit = this.tenantConcurrencyProvider(snapshot.tenant_id);
    const tenantLimit = rawTenantLimit instanceof Promise ? await rawTenantLimit : rawTenantLimit;

    try {
      await this.store.reserve({
        reservationId,
        apiKeyId,
        now,
        estimatedTokens,
        rpmLimit: snapshot.rpm ?? null,
        dailyLimit: snapshot.daily_tokens ?? null,
        monthlyLimit: snapshot.monthly_tokens ?? null,
        lifetimeBudget: snapshot.lifetime_token_budget ?? null,
        lifetimeConsumed: snapshot.lifetime_tokens_consumed ?? 0,
        concurrencyLimit: snapshot.max_concurrent ?? null,
        tenantId: snapshot.tenant_id,
        tenantConcurrencyLimit: tenantLimit,
      });
    } catch (error) {
      if (error instanceof GatewayError) {
        metrics.proxy_admission_total.inc(1, { reason: admissionMetricLabel(String(error.details.reason)) });
        throw error;
      }
      metrics.proxy_admission_total.inc(1, { reason: "admission_unavailable" });
      throw reasonToGatewayError("admission-unavailable", {
        cause: error instanceof Error ? error.message : "unknown",
      });
    }

    metrics.proxy_admission_total.inc(1, { reason: "ok" });

    let finalized = false;
    return {
      reservationId,
      apiKeyId,
      get released() {
        return finalized;
      },
      commitUsage: async (usage) => {
        if (finalized) return;
        const actual = usageTokens(usage);
        await this.store.reconcile(apiKeyId, estimatedTokens, actual, reservationId);
        finalized = true;
        // Persist the reconciled usage against `api_keys.lifetime_tokens_consumed`
        // so lifetime budgets survive a Redis flush; keyed on the actual
        // (not the reserved) tokens because the reservation was already
        // credited at admit-time and reconciled by the store above.
        if (snapshot.lifetime_token_budget != null && this.persistLifetimeUsage) {
          try {
            await this.persistLifetimeUsage({ apiKeyId, delta: actual });
          } catch {
            // Non-fatal: the transient counter already reflects reality; a
            // subsequent request will overwrite the row with the fresh count.
          }
        }
      },
      release: async () => {
        if (finalized) return;
        await this.store.release(apiKeyId, estimatedTokens, reservationId);
        finalized = true;
      },
    };
  }
}

const LEASE_TTL_MS = 3600_000;

/**
 * The lease key's own Redis TTL is deliberately LONGER than the `expires_at`
 * horizon the lease hash records.
 *
 * `expires_at` is the moment the sweeper becomes allowed to reclaim the lease.
 * If the key TTL equalled that horizon, Redis would evict the hash at exactly
 * the moment `reapIfExpired` wanted to read it: `HGET state` would return nil,
 * the sweep would skip it, and a crash between reserve and release would strand
 * the held concurrency / tenant-concurrency slot for as long as the counter
 * keeps being refreshed — every later reserve re-arms the counter's own TTL, so
 * a key still in use never recovers its leaked slot. The grace window keeps the
 * hash readable for several sweep intervals past the horizon, so the recovery
 * path actually runs.
 *
 * Exported so the invariant is asserted directly: a lease key must outlive the
 * horizon it records by more than one sweep interval (`sweepLeases` runs every
 * 30s, wired in `runtime/dependencies.ts`).
 */
const LEASE_TTL_GRACE_SECONDS = 120;
/** Seconds after which a lease hash is reapable (`expires_at` horizon). */
export const LEASE_REAP_HORIZON_SECONDS = Math.ceil(LEASE_TTL_MS / 1000);
/** Seconds the lease hash itself lives; must exceed the reap horizon. */
export const LEASE_KEY_TTL_SECONDS = LEASE_REAP_HORIZON_SECONDS + LEASE_TTL_GRACE_SECONDS;

function dailyBucket(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}
function monthlyBucket(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

/**
 * RESERVE — the atomic admission algorithm. Runs as one Redis Lua script so
 * every limit is validated and the reservation created in a single atomic
 * step: no read-modify-write race can let two requests through the last
 * remaining slot, and no partially applied reservation can survive (all
 * counter writes + the lease hash commit together or not at all).
 *
 * Idempotency: an existing lease hash in any state short-circuits to `1`
 * (already reserved) so a retried admission cannot double-charge counters.
 *
 * Limit model — rate limits vs concurrency:
 * - RPM (KEYS[1], a ZSET of timestamps): sliding 60s window, pruned with
 *   ZREMRANGEBYSCORE before counting. Admission is count-based, not
 *   token-based.
 * - Daily / monthly / lifetime token budgets (KEYS[2]/[3]/[5]): the
 *   *estimated* token count is pre-credited at reserve time and reconciled
 *   to actual usage later (RECONCILE_SCRIPT), so a request that would exceed
 *   its budget is rejected before dispatch, never after.
 * - Concurrency (KEYS[4], per API key) and tenant concurrency (KEYS[7]) are
 *   classic INCR/DECR slots held for the request duration; the lease hash
 *   (KEYS[6]) records which counters each reservation tracks so release
 *   reverses exactly those.
 *
 * Key naming: `admission:<kind>[:<apiKeyId>|<tenantId>][:<bucket>]` —
 * `admission:rpm:<key>`, `admission:daily:<key>:<YYYY-MM-DD>`,
 * `admission:monthly:<key>:<YYYY-MM>`, `admission:lifetime:<key>`,
 * `admission:concurrent:<key>`, `admission:tenant_concurrent:<tenant>`,
 * `admission:lease:<reservationId>`. All counters carry TTLs (roughly one
 * bucket + slack) so a process death cannot leak counters forever.
 *
 * Return codes: `0` reserved; `1` idempotent replay; `-1..-6` limit
 * rejections (mapped to GatewayErrors by `assertResult`); `-99` corrupt
 * counter state (never bypassed — admission fails closed).
 */
const RESERVE_SCRIPT = `
local state = redis.call('HGET', KEYS[6], 'state')
if state == 'active' or state == 'committed' or state == 'released' then return 1 end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]) - 60000)
local rpm = redis.call('ZCARD', KEYS[1])
local daily = tonumber(redis.call('GET', KEYS[2]) or '0')
local monthly = tonumber(redis.call('GET', KEYS[3]) or '0')
local concurrent = tonumber(redis.call('GET', KEYS[4]) or '0')
local tenantConcurrent = tonumber(redis.call('GET', KEYS[7]) or '0')
local lifetime = 0
if tonumber(ARGV[6]) then
  local rawLifetime = redis.call('GET', KEYS[5])
  lifetime = rawLifetime and tonumber(rawLifetime) or tonumber(ARGV[9])
  if not lifetime then return -99 end
  if not rawLifetime then redis.call('SET', KEYS[5], lifetime) end
end
local estimated = tonumber(ARGV[2])
if not estimated or estimated < 0 then return -99 end
if tonumber(ARGV[3]) and rpm >= tonumber(ARGV[3]) then return -1 end
if tonumber(ARGV[4]) and daily + estimated > tonumber(ARGV[4]) then return -2 end
if tonumber(ARGV[5]) and monthly + estimated > tonumber(ARGV[5]) then return -3 end
if tonumber(ARGV[6]) and lifetime + estimated > tonumber(ARGV[6]) then return -4 end
if tonumber(ARGV[7]) and concurrent >= tonumber(ARGV[7]) then return -5 end
if tonumber(ARGV[10]) and tenantConcurrent >= tonumber(ARGV[10]) then return -6 end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[8])
redis.call('EXPIRE', KEYS[1], 65)
if tonumber(ARGV[4]) then redis.call('INCRBY', KEYS[2], estimated); redis.call('EXPIRE', KEYS[2], 172800) end
if tonumber(ARGV[5]) then redis.call('INCRBY', KEYS[3], estimated); redis.call('EXPIRE', KEYS[3], 3024000) end
if tonumber(ARGV[6]) then redis.call('INCRBY', KEYS[5], estimated); redis.call('EXPIRE', KEYS[5], 3024000) end
if tonumber(ARGV[7]) then redis.call('INCR', KEYS[4]); redis.call('EXPIRE', KEYS[4], 3600) end
if tonumber(ARGV[10]) then redis.call('INCR', KEYS[7]); redis.call('EXPIRE', KEYS[7], 3600) end
redis.call('HSET', KEYS[6], 'state', 'active', 'reserved', estimated, 'daily', tonumber(ARGV[4]) and KEYS[2] or '', 'monthly', tonumber(ARGV[5]) and KEYS[3] or '', 'lifetime', tonumber(ARGV[6]) and KEYS[5] or '', 'concurrent', tonumber(ARGV[7]) and '1' or '0', 'tenant_concurrent', tonumber(ARGV[10]) and '1' or '0', 'tenant_id', ARGV[11], 'api_key_id', ARGV[12], 'expires_at', tonumber(ARGV[1]) + tonumber(ARGV[13]))
redis.call('EXPIRE', KEYS[6], tonumber(ARGV[14]))
return 0
`;

/**
 * RECONCILE — replaces the reservation's estimated token credit with actual
 * provider usage, atomically. Runs only on an `active` lease; reads which
 * counters the reservation credited from the lease hash, computes
 * `delta = actual - reserved`, validates the resulting counter values (no
 * negative drift), applies them, and decrements the held concurrency slots.
 * `actual` may be less than `reserved` (over-estimate refunded) or more
 * (under-estimate charged). Marks the lease `committed` — a second reconcile
 * or release is an idempotent no-op (`1`).
 */
const RECONCILE_SCRIPT = `
local state = redis.call('HGET', KEYS[1], 'state')
if state == 'committed' or state == 'released' then return 1 end
if state ~= 'active' then return -99 end
local reserved = tonumber(redis.call('HGET', KEYS[1], 'reserved'))
local actual = tonumber(ARGV[1])
if not reserved or not actual or reserved < 0 or actual < 0 or reserved ~= math.floor(reserved) or actual ~= math.floor(actual) then return -99 end
local delta = actual - reserved
local updates = {}
for _, field in ipairs({'daily', 'monthly', 'lifetime'}) do
  local key = redis.call('HGET', KEYS[1], field)
  if key and key ~= '' then
    local value = tonumber(redis.call('GET', key))
    if not value or value < 0 or value + delta < 0 or value + delta ~= math.floor(value + delta) then return -99 end
    table.insert(updates, {key, value + delta})
  end
end
local concurrentKey = 'admission:concurrent:' .. ARGV[2]
local hasConcurrency = redis.call('HGET', KEYS[1], 'concurrent') == '1'
if hasConcurrency then
  local value = tonumber(redis.call('GET', concurrentKey))
  if not value or value < 1 or value ~= math.floor(value) then return -99 end
end
local tenantKey = ''
local hasTenantConcurrency = redis.call('HGET', KEYS[1], 'tenant_concurrent') == '1'
if hasTenantConcurrency then
  local tenantId = redis.call('HGET', KEYS[1], 'tenant_id')
  if not tenantId or tenantId == '' then return -99 end
  tenantKey = 'admission:tenant_concurrent:' .. tenantId
  local value = tonumber(redis.call('GET', tenantKey))
  if not value or value < 1 or value ~= math.floor(value) then return -99 end
end
for _, update in ipairs(updates) do redis.call('SET', update[1], update[2]) end
if hasConcurrency then redis.call('DECR', concurrentKey) end
if hasTenantConcurrency then redis.call('DECR', tenantKey) end
redis.call('HSET', KEYS[1], 'state', 'committed', 'actual', actual)
return 0
`;

/**
 * RELEASE — reverses an uncommitted reservation exactly once: refunds the
 * pre-credited token estimates, decrements the held concurrency and tenant
 * slots, and marks the lease `released` (subsequent release/reconcile
 * returns `1`). Unlike the normal release path, crash-recovery releases
 * (`releaseAdmissionLease` / the sweeper) run this same script keyed only by
 * the lease hash; concurrency keys are rebuilt from `admission:concurrent:`
 * + the lease's `api_key_id` / `tenant_id` fields, so recovery never needs
 * the caller to remember which counters were held.
 */
const RELEASE_SCRIPT = `
local state = redis.call('HGET', KEYS[1], 'state')
if state == 'released' or state == 'committed' then return 1 end
if state ~= 'active' then return -99 end
local reserved = tonumber(redis.call('HGET', KEYS[1], 'reserved'))
if not reserved or reserved < 0 then return -99 end
for _, field in ipairs({'daily', 'monthly', 'lifetime'}) do local key = redis.call('HGET', KEYS[1], field); if key and key ~= '' then local value = tonumber(redis.call('GET', key) or '0'); if not value or value < reserved then return -99 end; redis.call('DECRBY', key, reserved) end end
if redis.call('HGET', KEYS[1], 'concurrent') == '1' then local key = 'admission:concurrent:' .. ARGV[1]; local value = tonumber(redis.call('GET', key) or '0'); if not value or value < 1 then return -99 end; redis.call('DECR', key) end
if redis.call('HGET', KEYS[1], 'tenant_concurrent') == '1' then local tenantId = redis.call('HGET', KEYS[1], 'tenant_id'); if not tenantId or tenantId == '' then return -99 end; local key = 'admission:tenant_concurrent:' .. tenantId; local value = tonumber(redis.call('GET', key) or '0'); if not value or value < 1 then return -99 end; redis.call('DECR', key) end
redis.call('HSET', KEYS[1], 'state', 'released')
return 0
`;
const RESULT_REASON: Record<number, AdmissionRejectionReason> = {
  [-1]: "rpm-exhausted",
  [-2]: "daily-token-limit",
  [-3]: "monthly-token-limit",
  [-4]: "lifetime-token-budget",
  [-5]: "concurrency-limit",
  [-6]: "tenant-capacity-exhausted",
};

function assertResult(result: number, operation: string): void {
  if (result === -99) throw new Error(`corrupt admission counter during ${operation}`);
  const reason = RESULT_REASON[result];
  if (reason) {
    throw reasonToGatewayError(reason, { operation });
  }
  if (result < 0) throw new Error(`admission rejected during ${operation}: ${result}`);
}

export class RedisAdmissionCounterStore implements AdmissionCounterStore {
  constructor(private readonly redis: RedisClient) {}
  async reserve(request: AdmissionReserveRequest): Promise<void> {
    const id = request.reservationId ?? `${request.apiKeyId}:${request.now}:${crypto.randomUUID()}`;
    const keys = [
      `admission:rpm:${request.apiKeyId}`,
      `admission:daily:${request.apiKeyId}:${dailyBucket(request.now)}`,
      `admission:monthly:${request.apiKeyId}:${monthlyBucket(request.now)}`,
      `admission:concurrent:${request.apiKeyId}`,
      `admission:lifetime:${request.apiKeyId}`,
      `admission:lease:${id}`,
      `admission:tenant_concurrent:${request.tenantId}`,
    ];
    const result = await redisEvalNumber(
      this.redis,
      RESERVE_SCRIPT,
      keys.length,
      ...keys,
        String(request.now),
        String(request.estimatedTokens),
        request.rpmLimit == null ? "" : String(request.rpmLimit),
        request.dailyLimit == null ? "" : String(request.dailyLimit),
        request.monthlyLimit == null ? "" : String(request.monthlyLimit),
        request.lifetimeBudget == null ? "" : String(request.lifetimeBudget),
        request.concurrencyLimit == null ? "" : String(request.concurrencyLimit),
        id,
        String(request.lifetimeConsumed),
        request.tenantConcurrencyLimit == null ? "" : String(request.tenantConcurrencyLimit),
        request.tenantId,
        request.apiKeyId,
        String(LEASE_TTL_MS),
        String(LEASE_KEY_TTL_SECONDS),
      );
    assertResult(result, "reserve");
  }
  async reconcile(
    apiKeyId: string,
    _reserved: number,
    actual: number,
    reservationId?: string,
  ): Promise<void> {
    if (!reservationId) throw new Error("reservation id required for atomic reconcile");
    const result = await redisEvalNumber(
      this.redis,
      RECONCILE_SCRIPT,
      1,
      `admission:lease:${reservationId}`,
      String(actual),
      apiKeyId,
    );
    assertResult(result, "reconcile");
  }
  async release(
    apiKeyId: string,
    _reserved: number,
    reservationId?: string,
  ): Promise<void> {
    if (!reservationId) throw new Error("reservation id required for atomic release");
    const result = await redisEvalNumber(
      this.redis,
      RELEASE_SCRIPT,
      1,
      `admission:lease:${reservationId}`,
      apiKeyId,
    );
    assertResult(result, "release");
  }

  /**
   * Drops every counter for one key (revocation). Active in-flight leases
   * settle through the release script first so their concurrency slots do
   * not leak; remaining lease rows expire via TTL. Best-effort by contract.
   */
  async purge(apiKeyId: string): Promise<void> {
    try {
      let cursor = "0";
      do {
        const [nextCursor, keys] = await this.redis.scan(
          cursor,
          "MATCH",
          "admission:lease:*",
          "COUNT",
          100,
        );
        cursor = String(nextCursor);
        const leaseKeys = keys as string[];
        if (leaseKeys.length === 0) continue;
        // One pipeline for the whole scan page instead of an HGET per lease:
        // the owner is a hash field, not part of the key, so the page has to be
        // read to find this key's leases — but it can be read in one round trip.
        // The key format stays `admission:lease:<reservationId>` (the id is not
        // always derived from the key id) so leases written before a deploy are
        // still found.
        const pipeline = this.redis.pipeline();
        for (const leaseKey of leaseKeys) pipeline.hget(leaseKey, "api_key_id");
        const owners = await pipeline.exec().catch(() => null);
        if (owners === null) continue;
        const owned = leaseKeys.filter((_, index) => {
          const entry = owners[index];
          return Array.isArray(entry) && entry[1] === apiKeyId;
        });
        for (const leaseKey of owned) {
          await redisEvalNumber(this.redis, RELEASE_SCRIPT, 1, leaseKey, apiKeyId).catch(
            () => -1,
          );
        }
      } while (cursor !== "0");
      let counterCursor = "0";
      const patterns = [`admission:*:${apiKeyId}`, `admission:*:${apiKeyId}:*`];
      for (const pattern of patterns) {
        do {
          const [nextCursor, keys] = await this.redis.scan(
            counterCursor,
            "MATCH",
            pattern,
            "COUNT",
            100,
          );
          counterCursor = String(nextCursor);
          if ((keys as string[]).length > 0) await this.redis.del(...(keys as string[]));
        } while (counterCursor !== "0");
      }
    } catch {
      // Best-effort: revocation already succeeded; stale counters expire via TTL.
    }
  }
}

/**
 * Releases a lease identified only by its Redis key (used by the sweeper).
 * Reads the owning api key id from the lease hash and runs RELEASE_SCRIPT,
 * which also releases the per-tenant concurrency slot when present.
 */
export async function releaseAdmissionLease(redis: RedisClient, leaseKey: string): Promise<void> {
  const apiKeyId = await redis.hget(leaseKey, "api_key_id");
  if (!apiKeyId) throw new Error("admission lease missing api_key_id");
  const result = await redisEvalNumber(redis, RELEASE_SCRIPT, 1, leaseKey, apiKeyId);
  assertResult(result, "release");
}

// Admission lease sweep: reaps crashed leases whose TTL expired so concurrent
// admission counters do not leak after a process dies before commit/release.
/**
 * Lease sweep: reaps crashed admission leases whose TTL has expired so
 * `admission:concurrent:*` and `admission:tenant_concurrent:*` do not leak
 * after a process dies before commit/release. Registered as a task on
 * `ScheduledTaskRegistry`, which owns the interval/re-entrancy/logging.
 */

const ADMISSION_LEASE_PATTERN = "admission:lease:*";

export async function sweepLeases(redis: RedisClient): Promise<void> {
  let cursor = "0";
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      "MATCH",
      ADMISSION_LEASE_PATTERN,
      "COUNT",
      100,
    );
    cursor = nextCursor;
    for (const key of keys) await reapIfExpired(redis, key);
  } while (cursor !== "0");
}

async function reapIfExpired(redis: RedisClient, key: string): Promise<void> {
  try {
    const state = await redis.hget(key, "state");
    if (state !== "active") return;
    const expiresAt = Number(await redis.hget(key, "expires_at"));
    if (!Number.isFinite(expiresAt) || expiresAt >= Date.now()) return;
    await releaseAdmissionLease(redis, key);
  } catch (error) {
    log.error("[lease-sweep] failed to reap lease", error as Error, key);
  }
}
