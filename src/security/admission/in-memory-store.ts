import type { AdmissionCounterStore, AdmissionReserveRequest } from "./contracts";
import { bucketKey, finiteNonNegative } from "./buckets";
import { reasonToGatewayError } from "./reasons";
import { dailyBucket, monthlyBucket } from "./ttl";

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
    await this.exclusive(async () => {
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
      // A missing counter is the only path that seeds from the snapshot; on
      // that path prefer a fresh persisted read over the ≤3s-stale snapshot,
      // otherwise the counter is frozen at a low baseline for its whole TTL.
      //
      // The callback is consulted only when a lifetime budget is set, matching the
      // Redis store (`request.lifetimeBudget != null && request.freshLifetimeConsumed`).
      // Without that guard the store awaited the callback first and only afterwards
      // found it had no key to write the value to — so every admitted request paid
      // the callback's cost (the wired one runs `findActiveById` plus
      // `sumChildrenConsumed`, two Postgres round trips) for a value it discarded.
      const cached = this.lifetime.get(request.apiKeyId);
      let lifetime: number;
      if (cached !== undefined) {
        lifetime = cached;
      } else if (request.lifetimeBudget != null && request.freshLifetimeConsumed) {
        const fresh = await request.freshLifetimeConsumed();
        lifetime =
          typeof fresh === "number" && Number.isFinite(fresh) && fresh >= 0
            ? Math.floor(fresh)
            : request.lifetimeConsumed;
      } else {
        lifetime = request.lifetimeConsumed;
      }
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

  async seedBuckets(request: {
    readonly apiKeyId: string;
    readonly now: number;
    readonly daily?: number;
    readonly monthly?: number;
  }): Promise<void> {
    await this.exclusive(() => {
      this.assertAvailable();
      const dailyKey = bucketKey(request.apiKeyId, dailyBucket(request.now));
      const monthlyKey = bucketKey(request.apiKeyId, monthlyBucket(request.now));
      if (request.daily !== undefined && !this.daily.has(dailyKey))
        this.daily.set(dailyKey, Math.floor(request.daily));
      if (request.monthly !== undefined && !this.monthly.has(monthlyKey))
        this.monthly.set(monthlyKey, Math.floor(request.monthly));
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
