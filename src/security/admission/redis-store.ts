import type { RedisClient } from "../../persistence/redis";
import { redisEvalNumber } from "../../persistence/redis";
import type { AdmissionCounterStore, AdmissionReserveRequest } from "./contracts";
import { assertResult, RECONCILE_SCRIPT, RELEASE_SCRIPT, RESERVE_SCRIPT } from "./lua";
import {
  DAILY_COUNTER_TTL_SECONDS,
  LEASE_KEY_TTL_SECONDS,
  LEASE_TTL_MS,
  MONTHLY_COUNTER_TTL_SECONDS,
  dailyBucket,
  monthlyBucket,
} from "./ttl";

export class RedisAdmissionCounterStore implements AdmissionCounterStore {
  constructor(private readonly redis: RedisClient) {}
  async reserve(request: AdmissionReserveRequest): Promise<void> {
    const id = request.reservationId ?? `${request.apiKeyId}:${request.now}:${crypto.randomUUID()}`;
    const lifetimeKey = `admission:lifetime:${request.apiKeyId}`;
    const keys = [
      `admission:rpm:${request.apiKeyId}`,
      `admission:daily:${request.apiKeyId}:${dailyBucket(request.now)}`,
      `admission:monthly:${request.apiKeyId}:${monthlyBucket(request.now)}`,
      `admission:concurrent:${request.apiKeyId}`,
      lifetimeKey,
      `admission:lease:${id}`,
      `admission:tenant_concurrent:${request.tenantId}`,
    ];
    // The lifetime seed is the one write the Lua script cannot re-issue: once
    // the counter exists it never re-reads Postgres. If we are about to create
    // it, prefer a fresh persisted read over the ≤3s-stale snapshot value,
    // otherwise a snapshot that missed a recent commit freezes a low baseline
    // for the counter's whole 35-day TTL. `EXISTS` is a single extra command
    // and runs only for keys that actually have a lifetime budget.
    let lifetimeSeed = request.lifetimeConsumed;
    if (request.lifetimeBudget != null && request.freshLifetimeConsumed) {
      const exists = await this.redis.exists(lifetimeKey).catch(() => 1);
      if (exists === 0) {
        const fresh = await request.freshLifetimeConsumed().catch(() => undefined);
        if (typeof fresh === "number" && Number.isFinite(fresh) && fresh >= 0) {
          lifetimeSeed = Math.floor(fresh);
        }
      }
    }
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
        String(lifetimeSeed),
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
   * `SET NX`-seeds the current bucket's counters from already-recorded usage.
   * NX is what makes this safe: an existing counter is the live running total,
   * and overwriting it would erase spend. Best-effort by contract.
   */
  async seedBuckets(request: {
    readonly apiKeyId: string;
    readonly now: number;
    readonly daily?: number;
    readonly monthly?: number;
  }): Promise<void> {
    try {
      const operations: Promise<unknown>[] = [];
      if (request.daily !== undefined && request.daily > 0) {
        operations.push(
          this.redis.set(
            `admission:daily:${request.apiKeyId}:${dailyBucket(request.now)}`,
            Math.floor(request.daily),
            "EX",
            DAILY_COUNTER_TTL_SECONDS,
            "NX",
          ),
        );
      }
      if (request.monthly !== undefined && request.monthly > 0) {
        operations.push(
          this.redis.set(
            `admission:monthly:${request.apiKeyId}:${monthlyBucket(request.now)}`,
            Math.floor(request.monthly),
            "EX",
            MONTHLY_COUNTER_TTL_SECONDS,
            "NX",
          ),
        );
      }
      await Promise.all(operations);
    } catch {
      // Seeding is an optimisation, not a correctness gate.
    }
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
