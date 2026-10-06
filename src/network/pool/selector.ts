/**
 * `NetworkPoolSelector` — distributed pool admission: weighted, cooldown-aware
 * selection plus inflight accounting (local map + Redis counters for
 * multi-process correctness).
 *
 * Role files: `pool-scripts.ts` (Redis scripts + key builders),
 * `pool-state.ts` (local inflight/rotation/cooldown state). This file keeps
 * the selection algorithm and the `NetworkPoolSelector` public surface.
 */
import { redisEvalNumber, type RedisClient } from "../../persistence/redis";
import { resolveInflightTtlSeconds } from "../../config/timeouts";
import { log } from "../../observability/logger";
import {
  COOLDOWN_CLEAR_SCRIPT,
  COOLDOWN_FLAG_SCRIPT,
  POOL_ADMIT_SCRIPT,
  POOL_RELEASE_SCRIPT,
  proxyCooldownKey,
  proxyCooldownProvidersKey,
  proxyInflightKey,
} from "./pool-scripts";
import {
  advanceRotation,
  createPoolLocalState,
  enforceCooldownLimit,
  enforceInflightLimit,
  parseCooldownEntry,
  rotationStart,
  type PoolLocalState,
  type PoolRotation,
  type PoolUsageSnapshot,
  type ProxyCooldownEntry,
} from "./pool-state";

export type { PoolRotation, PoolUsageSnapshot, ProxyCooldownEntry };
export { parseCooldownEntry };

// Pool selector
export const DEFAULT_PROXY_CONCURRENCY = 10;
const DEFAULT_PROXY_WEIGHT = 100;
const MAX_PROXY_WEIGHT = 1000;
// Crash-recovery bound, not a lease duration: normal releases DECR/DEL the
// key immediately, so the TTL only matters when a holder dies mid-request.
// Derived by `resolveInflightTtlSeconds` from the same resolvers the dispatch
// path uses, so raising either timeout keeps the invariant — and so this
// selector and the routing admission controller expire their slots on the same
// bound, since both hold one for the same request duration.
function poolInflightTtlSeconds(): number {
  return resolveInflightTtlSeconds();
}
export function effectiveConcurrency(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) return 0;
  return limit;
}

function normalizedWeight(weight: number | undefined): number {
  if (weight === undefined) return DEFAULT_PROXY_WEIGHT;
  if (!Number.isInteger(weight) || weight < 1 || weight > MAX_PROXY_WEIGHT) return 0;
  return weight;
}

export type PoolSelectionFailureReason =
  | "at_capacity"
  | "cooldown"
  | "coordination_unavailable"
  | "no_active_pool";

export interface PoolCapacitySnapshot {
  readonly poolId: string;
  readonly maxInflight: number;
  readonly currentInflight: number;
  readonly available: number;
  readonly weight: number;
  readonly retryAt?: number;
}

export interface PoolSelectionFailure {
  readonly reason: PoolSelectionFailureReason;
  readonly pools: readonly PoolCapacitySnapshot[];
  readonly retryAt?: number;
}

export class NetworkPoolSelector {
  private readonly state: PoolLocalState = createPoolLocalState();

  constructor(private readonly redis?: RedisClient) {}

  getInflight(poolId: string): number {
    return this.state.inflight.get(poolId) ?? 0;
  }

  /**
   * Live usage across every locally tracked pool: one `{poolId, inflight}`
   * row per pool the selector has admitted since boot. Zero-count pools drop
   * out of the map on release, so an idle pool reads as absent (i.e. zero)
   * rather than as a stale row. Process-local like `getInflight` — the Usage
   * page's pool card renders its own instance's view.
   */
  snapshotPoolUsage(): readonly PoolUsageSnapshot[] {
    const out: PoolUsageSnapshot[] = [];
    for (const [poolId, currentInflight] of this.state.inflight) {
      out.push({ poolId, currentInflight });
    }
    return out;
  }

  private readonly poolUsageListeners = new Set<(usage: readonly PoolUsageSnapshot[]) => void>();

  /**
   * Push-on-change subscription for pool usage, mirroring the in-flight
   * request counter's pub/sub. Emitted on every acquire/release so an SSE
   * stream can forward only real transitions instead of polling.
   */
  subscribePoolUsage(listener: (usage: readonly PoolUsageSnapshot[]) => void): () => void {
    this.poolUsageListeners.add(listener);
    return () => {
      this.poolUsageListeners.delete(listener);
    };
  }

  private notifyPoolUsage(): void {
    if (this.poolUsageListeners.size === 0) return;
    const snapshot = this.snapshotPoolUsage();
    for (const listener of this.poolUsageListeners) listener(snapshot);
  }

  async getInflightAuthoritative(poolId: string): Promise<number> {
    if (!this.redis) return this.getInflight(poolId);
    const raw = await this.redis.get(proxyInflightKey(poolId));
    if (raw === null) return 0;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`invalid pool inflight counter: ${poolId}`);
    }
    return value;
  }

  acquire(
    poolId: string,
    maxInflight = DEFAULT_PROXY_CONCURRENCY,
  ): { acquired: boolean; release: () => void } {
    const current = this.getInflight(poolId);
    if (current >= maxInflight) {
      return { acquired: false, release: () => {} };
    }

    enforceInflightLimit(this.state.inflight);
    this.state.inflight.set(poolId, current + 1);
    this.notifyPoolUsage();
    let released = false;

    const release = () => {
      if (released) return;
      released = true;
      const val = this.state.inflight.get(poolId) ?? 1;
      if (val <= 1) {
        this.state.inflight.delete(poolId);
      } else {
        this.state.inflight.set(poolId, val - 1);
      }
      this.notifyPoolUsage();
    };

    return { acquired: true, release };
  }

  private cooldownKey(poolId: string, providerId: string): string {
    return `${poolId}::${providerId.toLowerCase()}`;
  }

  async flagProviderCooldown(
    poolId: string,
    providerId: string,
    durationMs: number = 15 * 60 * 1000,
    reason = "Rate limited by upstream provider (429)",
  ): Promise<ProxyCooldownEntry> {
    const until = Date.now() + durationMs;
    const entry: ProxyCooldownEntry = {
      poolId,
      providerId: providerId.toLowerCase(),
      until,
      reason: reason.slice(0, 200),
    };
    enforceCooldownLimit(this.state.cooldowns);
    this.state.cooldowns.set(this.cooldownKey(poolId, providerId), entry);
    if (this.redis) {
      try {
        const ttlSec = Math.max(1, Math.ceil(durationMs / 1000));
        // One script, not `SET` then `SADD`: a crash between the two left the
        // marker unindexed (invisible to the pool listing) or the index
        // pointing at a marker that expired. The script also arms the index
        // set's own TTL, which previously had none and so grew without bound.
        await redisEvalNumber(
          this.redis,
          COOLDOWN_FLAG_SCRIPT,
          2,
          proxyCooldownKey(poolId, providerId),
          proxyCooldownProvidersKey(poolId),
          JSON.stringify(entry),
          ttlSec,
          entry.providerId,
        );
      } catch {
        // The local entry remains conservative for this process.
      }
    }
    return entry;
  }

  async isProviderCooldown(
    poolId: string,
    providerId: string,
  ): Promise<{ inCooldown: boolean; resetsAt: Date | null; reason: string | null }> {
    const k = this.cooldownKey(poolId, providerId);
    const local = this.state.cooldowns.get(k);
    if (local) {
      if (Date.now() < local.until) {
        return { inCooldown: true, resetsAt: new Date(local.until), reason: local.reason };
      }
      this.state.cooldowns.delete(k);
    }
    if (this.redis) {
      try {
        const raw = await this.redis.get(proxyCooldownKey(poolId, providerId));
        const parsed = raw ? parseCooldownEntry(raw) : undefined;
        if (parsed && Date.now() < parsed.until) {
          enforceCooldownLimit(this.state.cooldowns);
          this.state.cooldowns.set(k, parsed);
          return { inCooldown: true, resetsAt: new Date(parsed.until), reason: parsed.reason };
        }
        if (raw) {
          await this.clearRedisCooldown(poolId, providerId);
        }
      } catch {
        return {
          inCooldown: true,
          resetsAt: null,
          reason: "cooldown store unavailable",
        };
      }
    }
    return { inCooldown: false, resetsAt: null, reason: null };
  }

  async getPoolCooldowns(poolId: string): Promise<readonly ProxyCooldownEntry[]> {
    const now = Date.now();
    const active = new Map<string, ProxyCooldownEntry>();

    for (const [key, entry] of this.state.cooldowns.entries()) {
      if (entry.poolId !== poolId) continue;
      if (now < entry.until) active.set(entry.providerId, entry);
      else this.state.cooldowns.delete(key);
    }

    if (this.redis) {
      const providerIds = await this.redis.smembers(proxyCooldownProvidersKey(poolId));
      // A pool with no cooling providers — the common case, and every pool when
      // nothing is throttled — lists no members. `MGET` requires at least one
      // key, so calling it with an empty spread makes Redis reject the command
      // and the whole pool read fail; a healthy pool must report zero cooldowns,
      // not an error. The loop below is a no-op for an empty list, so returning
      // early is the same result without the round trip.
      if (providerIds.length === 0) return [...active.values()];
      // One MGET for every listed member instead of a GET per member: this is
      // the pool overview's hot read, so a serial scan made its latency scale
      // with the pool's provider count.
      const raws = (await this.redis.mget(
        ...providerIds.map((providerId) => proxyCooldownKey(poolId, providerId)),
      )) as Array<string | null>;
      for (let index = 0; index < providerIds.length; index += 1) {
        const providerId = providerIds[index];
        if (providerId === undefined) continue;
        const raw = raws[index] ?? null;
        const entry = raw ? parseCooldownEntry(raw) : undefined;
        if (!entry) {
          if (raw) await this.redis.del(proxyCooldownKey(poolId, providerId));
          await this.redis.srem(proxyCooldownProvidersKey(poolId), providerId);
          continue;
        }
        if (entry.poolId === poolId && now < entry.until) active.set(entry.providerId, entry);
        else await this.redis.srem(proxyCooldownProvidersKey(poolId), providerId);
      }
    }

    return [...active.values()];
  }
  async clearProviderCooldown(poolId: string, providerId: string): Promise<void> {
    this.state.cooldowns.delete(this.cooldownKey(poolId, providerId));
    if (!this.redis) return;
    await this.clearRedisCooldown(poolId, providerId);
  }

  /**
   * Removes one cooldown marker and its index entry in one atomic step.
   *
   * The two writes used to be separate `DEL` + `SREM`, so a crash between them
   * left the index listing a provider whose marker was gone — a pool would
   * report a cooldown that no longer applied until the index entry expired.
   */
  private async clearRedisCooldown(poolId: string, providerId: string): Promise<void> {
    if (!this.redis) return;
    await redisEvalNumber(
      this.redis,
      COOLDOWN_CLEAR_SCRIPT,
      2,
      proxyCooldownKey(poolId, providerId),
      proxyCooldownProvidersKey(poolId),
      providerId.toLowerCase(),
    );
  }

  /**
   * Drops every cooldown this pool holds, marker and index together.
   *
   * Called when a pool is deleted: without it the index set and its markers
   * outlive the pool row, so a later pool reusing the id inherits cooldowns it
   * never earned.
   */
  async clearPoolCooldowns(poolId: string): Promise<void> {
    for (const key of [...this.state.cooldowns.keys()]) {
      if (key.startsWith(`${poolId}::`)) this.state.cooldowns.delete(key);
    }
    if (!this.redis) return;
    const indexKey = proxyCooldownProvidersKey(poolId);
    const providerIds = await this.redis.smembers(indexKey);
    for (const providerId of providerIds) {
      await this.redis.del(proxyCooldownKey(poolId, providerId));
    }
    await this.redis.del(indexKey);
  }

  /**
   * Distributed pool admission — the selection algorithm:
   *
   * 1. Eligibility: a pool is skipped while it (or any pool) has an active
   *    provider cooldown (429 from upstream), a non-positive capacity
   *    (`effectiveConcurrency`), or a non-positive weight.
   * 2. Weighted least-loaded scoring: each eligible pool is scored by
   *    `inflight / (capacity × weight)`, so heavy pools carry proportionally
   *    more traffic and a higher `weight` makes a pool proportionally more
   *    attractive. Inflight comes from the local map in single-process mode
   *    or the authoritative Redis counter when coordinated.
   * 3. Fair tie-breaking: a rotating `fairnessCursor` staggers the scan order
   *    so equal-scoring pools are filled round-robin instead of always
   *    favoring the first candidate.
   * 4. Atomic acquisition: with Redis, each candidate is tried in scored
   *    order via the `POOL_ADMIT_SCRIPT` compare-and-increment, so two
   *    processes cannot both grab the last slot. The returned `release()`
   *    decrements both the local map and the Redis counter (fire-and-forget:
   *    a failed release is logged; the 480s TTL bounds crash leakage).
   *
   * Returns `undefined` when every pool is cooling, at capacity, or
   * uncoordinated — callers convert that into a `proxy_pool_unavailable` /
   * `PoolSelectionFailure` response rather than falling back to direct
   * egress.
   *
   * When `rotation` is supplied, scoring is replaced by strict round-robin:
   * the tenant cursor picks the start, one pool serves `rotateCount`
   * successful admissions before the cursor advances by one, and a pool that
   * is full or cooling falls through to the next offset (failover),
   * preserving every gate above.
   */
  async tryAcquireAvailablePool(
    eligiblePoolIds: readonly string[],
    providerId: string,
    limitsByPool?: Record<string, number>,
    weightsByPool?: Record<string, number>,
    rotation?: PoolRotation,
  ): Promise<{ poolId: string; release: () => void } | undefined> {
    if (eligiblePoolIds.length === 0) return undefined;
    const cooldownChecks = await Promise.all(
      eligiblePoolIds.map(async (poolId) => ({
        poolId,
        inCooldown: (await this.isProviderCooldown(poolId, providerId)).inCooldown,
      })),
    );
    const scored = cooldownChecks
      .filter((check) => !check.inCooldown)
      .map((check) => {
        const capacity = effectiveConcurrency(
          limitsByPool?.[check.poolId] ?? DEFAULT_PROXY_CONCURRENCY,
        );
        const weight = normalizedWeight(weightsByPool?.[check.poolId]);
        return { poolId: check.poolId, capacity, weight };
      })
      .filter((candidate) => candidate.capacity > 0 && candidate.weight > 0);
    if (scored.length === 0) return undefined;

    if (!this.redis) {
      if (rotation) {
        // Round robin: scan from the tenant cursor; a pool that is full falls
        // through to the next offset (failover). Only a successful admission
        // counts: the head pool serves `rotateCount` requests, then the
        // position advances by exactly one.
        const start = rotationStart(this.state.rotationCursors, rotation.key, scored.length);
        for (let offset = 0; offset < scored.length; offset += 1) {
          const absolute = (start + offset) % scored.length;
          const candidate = scored[absolute];
          if (!candidate) continue;
          if (this.getInflight(candidate.poolId) >= candidate.capacity) continue;
          const slot = this.acquire(candidate.poolId, candidate.capacity);
          if (!slot.acquired) continue;
          advanceRotation(this.state.rotationCursors, rotation.key, scored.length, absolute, rotation.rotateCount);
          return { poolId: candidate.poolId, release: slot.release };
        }
        return undefined;
      }
      let bestPool: (typeof scored)[number] | undefined;
      let minRatio = Number.POSITIVE_INFINITY;
      const start = this.state.fairnessCursor++ % scored.length;
      for (let offset = 0; offset < scored.length; offset += 1) {
        const candidate = scored[(start + offset) % scored.length];
        if (!candidate) continue;
        const current = this.getInflight(candidate.poolId);
        if (current >= candidate.capacity) continue;
        const ratio = current / (candidate.capacity * candidate.weight);
        if (ratio < minRatio) {
          minRatio = ratio;
          bestPool = candidate;
        }
      }
      if (!bestPool) return undefined;
      const slot = this.acquire(bestPool.poolId, bestPool.capacity);
      return slot.acquired ? { poolId: bestPool.poolId, release: slot.release } : undefined;
    }

    const redis = this.redis;
    // One MGET for every candidate instead of a GET per candidate: the
    // per-pool script below already guarantees capacity atomically, so the
    // pre-read is only a score, but serial GETs made admission latency scale
    // with the candidate count on exactly the path that runs per request.
    const inflightKeys = scored.map((candidate) => proxyInflightKey(candidate.poolId));
    const rawCounts = (await redis.mget(...inflightKeys)) as Array<string | null>;
    const withCounts = scored.map((candidate, index) => {
      const raw = rawCounts[index] ?? null;
      const count = raw === null ? 0 : Number(raw);
      if (!Number.isFinite(count) || count < 0) {
        throw new Error(`invalid pool inflight counter: ${candidate.poolId}`);
      }
      return {
        ...candidate,
        count,
        ratio: count / (candidate.capacity * candidate.weight),
      };
    });
    // Original (pre-sort) index = absolute rotation position and
    // deterministic tie-breaking.
    const absoluteIndex = new Map(withCounts.map((candidate, index) => [candidate.poolId, index]));
    if (rotation) {
      // Round robin orders strictly by the tenant cursor; the CAS admit below
      // still enforces capacity, so a full pool falls through to the next
      // offset exactly like account failover.
      const start = rotationStart(this.state.rotationCursors, rotation.key, withCounts.length);
      withCounts.sort(
        (left, right) =>
          (((absoluteIndex.get(left.poolId) ?? 0) - start + withCounts.length) %
            withCounts.length) -
          (((absoluteIndex.get(right.poolId) ?? 0) - start + withCounts.length) %
            withCounts.length),
      );
    } else {
      const start = this.state.fairnessCursor++ % withCounts.length;
      const tieOrder = absoluteIndex;
      withCounts.sort((left, right) => {
        const ratioDifference = left.ratio - right.ratio;
        if (ratioDifference !== 0) return ratioDifference;
        const leftIndex = tieOrder.get(left.poolId) ?? 0;
        const rightIndex = tieOrder.get(right.poolId) ?? 0;
        return ((leftIndex - start + withCounts.length) % withCounts.length) -
          ((rightIndex - start + withCounts.length) % withCounts.length);
      });
    }
    for (const candidate of withCounts) {
      const result = await redisEvalNumber(
        redis,
        POOL_ADMIT_SCRIPT,
        1,
        proxyInflightKey(candidate.poolId),
        String(candidate.capacity),
        String(poolInflightTtlSeconds()),
      );
      if (result !== 1) continue;
      if (rotation) {
        advanceRotation(
          this.state.rotationCursors,
          rotation.key,
          withCounts.length,
          absoluteIndex.get(candidate.poolId) ?? 0,
          rotation.rotateCount,
        );
      }
      enforceInflightLimit(this.state.inflight);
      this.state.inflight.set(candidate.poolId, this.getInflight(candidate.poolId) + 1);
      this.notifyPoolUsage();
      let released = false;
      return {
        poolId: candidate.poolId,
        release: () => {
          if (released) return;
          released = true;
          const local = this.getInflight(candidate.poolId);
          if (local <= 1) this.state.inflight.delete(candidate.poolId);
          else this.state.inflight.set(candidate.poolId, local - 1);
          this.notifyPoolUsage();
          void redisEvalNumber(redis, POOL_RELEASE_SCRIPT, 1, proxyInflightKey(candidate.poolId)).catch(
            (error: unknown) => {
              log.error("[pool-selector] failed to release distributed slot", error as Error);
            },
          );
        },
      };
    }
    return undefined;
  }
  async getSelectionFailure(
    eligiblePoolIds: readonly string[],
    providerId: string,
    limitsByPool?: Record<string, number>,
    weightsByPool?: Record<string, number>,
  ): Promise<PoolSelectionFailure> {
    if (eligiblePoolIds.length === 0) return { reason: "no_active_pool", pools: [] };
    try {
      // One pass, not two: the cooldown lookup is a Redis read per pool, and
      // the first version read it once for the capacity snapshot and again for
      // the rejection decision, doubling the round trips on exactly the path
      // that runs when selection fails.
      const checks = await Promise.all(
        eligiblePoolIds.map(async (poolId) => {
          const cooldown = await this.isProviderCooldown(poolId, providerId);
          const maxInflight = effectiveConcurrency(
            limitsByPool?.[poolId] ?? DEFAULT_PROXY_CONCURRENCY,
          );
          const weight = normalizedWeight(weightsByPool?.[poolId]);
          const currentInflight = await this.getInflightAuthoritative(poolId);
          return {
            cooldown,
            pool: {
              poolId,
              maxInflight,
              currentInflight,
              available: Math.max(0, maxInflight - currentInflight),
              weight,
              ...(cooldown.resetsAt ? { retryAt: cooldown.resetsAt.getTime() } : {}),
            } satisfies PoolCapacitySnapshot,
          };
        }),
      );
      const pools = checks.map((check) => check.pool);
      const cooldowns = checks.map((check) => check.cooldown);
      if (cooldowns.some((entry) => entry.reason === "cooldown store unavailable")) {
        return { reason: "coordination_unavailable", pools };
      }
      const active = pools.filter((pool) => pool.maxInflight > 0 && pool.weight > 0);
      if (active.length === 0) return { reason: "no_active_pool", pools };
      const allCooling = cooldowns.every((entry) => entry.inCooldown);
      if (allCooling) {
        const retryAt = Math.min(
          ...cooldowns
            .map((entry) => entry.resetsAt?.getTime())
            .filter((value): value is number => value !== undefined),
        );
        return {
          reason: "cooldown",
          pools,
          ...(Number.isFinite(retryAt) ? { retryAt } : {}),
        };
      }
      return { reason: "at_capacity", pools };
    } catch {
      return { reason: "coordination_unavailable", pools: [] };
    }
  }
}
