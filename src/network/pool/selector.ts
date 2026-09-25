/**
 * `NetworkPoolSelector` — distributed pool admission: weighted, cooldown-aware
 * selection plus inflight accounting (local map + Redis counters for
 * multi-process correctness).
 */
import { redisEvalNumber, type RedisClient } from "../../persistence/redis";
import { isRecord } from "../../protocol/primitives";
import { resolveInflightTtlSeconds } from "../../config";
import { log } from "../../observability/logger";

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
const POOL_ADMIT_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current >= tonumber(ARGV[1]) then return 0 end
redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
return 1
`;
const POOL_RELEASE_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current <= 1 then redis.call('DEL', KEYS[1]); return 0 end
return redis.call('DECR', KEYS[1])
`;
export function effectiveConcurrency(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) return 0;
  return limit;
}

function normalizedWeight(weight: number | undefined): number {
  if (weight === undefined) return DEFAULT_PROXY_WEIGHT;
  if (!Number.isInteger(weight) || weight < 1 || weight > MAX_PROXY_WEIGHT) return 0;
  return weight;
}

export interface ProxyCooldownEntry {
  readonly poolId: string;
  readonly providerId: string;
  readonly until: number;
  readonly reason: string;
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

function parseCooldownEntry(raw: string): ProxyCooldownEntry | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      isRecord(parsed) &&
      typeof parsed.poolId === "string" &&
      typeof parsed.providerId === "string" &&
      typeof parsed.until === "number" &&
      Number.isFinite(parsed.until) &&
      typeof parsed.reason === "string"
    ) {
      return {
        poolId: parsed.poolId,
        providerId: parsed.providerId.toLowerCase(),
        until: parsed.until,
        reason: parsed.reason.slice(0, 200),
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Round-robin rotation request for one selection — present ⇒ rotate across
 * the eligible pools instead of scoring by load. `key` scopes the cursor (the
 * pool-owning tenant, so two tenants never share rotation position);
 * `rotateCount` is how many requests one pool serves before advancing,
 * clamped to 1..1000 exactly like the account strategy. Absent ⇒ the default
 * weighted least-loaded scan.
 */
export interface PoolRotation {
  readonly key: string;
  readonly rotateCount: number;
}

export interface PoolUsageSnapshot {
  readonly poolId: string;
  readonly currentInflight: number;
}

export class NetworkPoolSelector {
  /** Bound on locally tracked inflight counters (paranoia: keys are pool ids, so the real bound is the pool count). */
  private static readonly MAX_INFLIGHT_ENTRIES = 10_000;
  /** Bound on locally cached cooldown entries (pools × providers). */
  private static readonly MAX_COOLDOWN_ENTRIES = 5_000;
  /** Bound on round-robin rotation cursors (one per pool-owning tenant). */
  private static readonly MAX_ROTATION_KEYS = 5_000;

  private readonly inflight = new Map<string, number>();
  private readonly cooldowns = new Map<string, ProxyCooldownEntry>();
  /** Per-key round-robin state: scan position + admissions the pool at that position has served. */
  private readonly rotationCursors = new Map<string, { pos: number; served: number }>();
  private fairnessCursor = 0;

  /** Evicts expired cooldown entries first, then oldest-inserted ones past the bound. */
  private enforceCooldownLimit(): void {
    if (this.cooldowns.size < NetworkPoolSelector.MAX_COOLDOWN_ENTRIES) return;
    const now = Date.now();
    for (const [key, entry] of this.cooldowns) {
      if (now >= entry.until) this.cooldowns.delete(key);
    }
    while (this.cooldowns.size >= NetworkPoolSelector.MAX_COOLDOWN_ENTRIES) {
      const oldestKey = this.cooldowns.keys().next().value;
      if (oldestKey === undefined) break;
      this.cooldowns.delete(oldestKey);
    }
  }

  /**
   * Bounds the local inflight map by evicting the oldest-inserted counter.
   * With Redis the evicted pool's count stays authoritative there; the local
   * map only re-seeds, so worst case one pool briefly over-admits locally.
   */
  private enforceInflightLimit(): void {
    if (this.inflight.size < NetworkPoolSelector.MAX_INFLIGHT_ENTRIES) return;
    const oldestKey = this.inflight.keys().next().value;
    if (oldestKey !== undefined) {
      this.inflight.delete(oldestKey);
      log.warn(
        `[pool-selector] local inflight map exceeded ${NetworkPoolSelector.MAX_INFLIGHT_ENTRIES} entries; evicted oldest counter`,
      );
    }
  }

  constructor(private readonly redis?: RedisClient) {}

  /** Next rotation start offset for `key`; an unknown key starts at 0. */
  private rotationStart(key: string, length: number): number {
    const pos = this.rotationCursors.get(key)?.pos ?? 0;
    return ((pos % length) + length) % length;
  }

  /**
   * Record a successful admission at `absoluteIndex` — called only after the
   * pool actually acquired a slot, so a failed or cooling selection never
   * consumes rotation position. The scan resumes at `pos` until this pool has
   * served `rotateCount` requests, then advances by exactly one position:
   * striding the position by `rotateCount` steps per admission skips pools
   * whenever the pool count and `rotateCount` share a factor (2 pools with
   * `rotateCount` 2 pinned one pool forever). An index that is not `pos`
   * means the eligible list changed under the scan (shrank, or failover
   * jumped past a full pool); re-anchor there with a fresh served count.
   * State is per-process like the account `RoundRobinState`; the map is
   * bounded oldest-inserted-first.
   */
  private advanceRotation(
    key: string,
    length: number,
    absoluteIndex: number,
    rotateCount: number,
  ): void {
    if (
      !this.rotationCursors.has(key) &&
      this.rotationCursors.size >= NetworkPoolSelector.MAX_ROTATION_KEYS
    ) {
      const oldest = this.rotationCursors.keys().next().value;
      if (oldest !== undefined) this.rotationCursors.delete(oldest);
    }
    const safeCount = Math.max(1, Math.min(1000, Math.trunc(rotateCount)));
    const current = this.rotationCursors.get(key) ?? { pos: 0, served: 0 };
    if (absoluteIndex !== current.pos) {
      this.rotationCursors.set(key, { pos: absoluteIndex, served: 1 });
      return;
    }
    const served = current.served + 1;
    this.rotationCursors.set(
      key,
      served >= safeCount
        ? { pos: (absoluteIndex + 1) % length, served: 0 }
        : { pos: current.pos, served },
    );
  }

  getInflight(poolId: string): number {
    return this.inflight.get(poolId) ?? 0;
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
    for (const [poolId, currentInflight] of this.inflight) {
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
    const raw = await this.redis.get(this.redisInflightKey(poolId));
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

    this.enforceInflightLimit();
    this.inflight.set(poolId, current + 1);
    this.notifyPoolUsage();
    let released = false;

    const release = () => {
      if (released) return;
      released = true;
      const val = this.inflight.get(poolId) ?? 1;
      if (val <= 1) {
        this.inflight.delete(poolId);
      } else {
        this.inflight.set(poolId, val - 1);
      }
      this.notifyPoolUsage();
    };

    return { acquired: true, release };
  }

  private cooldownKey(poolId: string, providerId: string): string {
    return `${poolId}::${providerId.toLowerCase()}`;
  }

  private redisCooldownKey(poolId: string, providerId: string): string {
    return `proxy:cooldown:${poolId}:${providerId.toLowerCase()}`;
  }

  private redisCooldownProvidersKey(poolId: string): string {
    return `proxy:cooldown:providers:${poolId}`;
  }

  /** One cooldown marker plus its index entry, written atomically. */
  private static readonly COOLDOWN_FLAG_SCRIPT = `
    redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
    redis.call('SADD', KEYS[2], ARGV[3])
    -- The index set must outlive every marker it lists, or it is evicted while
    -- a cooldown is still active and the pair becomes invisible to other
    -- processes. EXPIRE ... GT only ever extends, so a later short cooldown
    -- cannot shorten a longer one already indexed.
    local ttl = redis.call('TTL', KEYS[1])
    if ttl > 0 then
      local current = redis.call('TTL', KEYS[2])
      if current < 0 or ttl > current then redis.call('EXPIRE', KEYS[2], ttl) end
    end
    return 1
  `;

  /** Clears one cooldown marker and its index entry atomically. */
  private static readonly COOLDOWN_CLEAR_SCRIPT = `
    redis.call('DEL', KEYS[1])
    redis.call('SREM', KEYS[2], ARGV[1])
    return 1
  `;

  private redisInflightKey(poolId: string): string {
    return `proxy:inflight:${poolId}`;
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
    this.enforceCooldownLimit();
    this.cooldowns.set(this.cooldownKey(poolId, providerId), entry);
    if (this.redis) {
      try {
        const ttlSec = Math.max(1, Math.ceil(durationMs / 1000));
        // One script, not `SET` then `SADD`: a crash between the two left the
        // marker unindexed (invisible to the pool listing) or the index
        // pointing at a marker that expired. The script also arms the index
        // set's own TTL, which previously had none and so grew without bound.
        await redisEvalNumber(
          this.redis,
          NetworkPoolSelector.COOLDOWN_FLAG_SCRIPT,
          2,
          this.redisCooldownKey(poolId, providerId),
          this.redisCooldownProvidersKey(poolId),
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
    const local = this.cooldowns.get(k);
    if (local) {
      if (Date.now() < local.until) {
        return { inCooldown: true, resetsAt: new Date(local.until), reason: local.reason };
      }
      this.cooldowns.delete(k);
    }
    if (this.redis) {
      try {
        const raw = await this.redis.get(this.redisCooldownKey(poolId, providerId));
        const parsed = raw ? parseCooldownEntry(raw) : undefined;
        if (parsed && Date.now() < parsed.until) {
          this.enforceCooldownLimit();
          this.cooldowns.set(k, parsed);
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

    for (const [key, entry] of this.cooldowns.entries()) {
      if (entry.poolId !== poolId) continue;
      if (now < entry.until) active.set(entry.providerId, entry);
      else this.cooldowns.delete(key);
    }

    if (this.redis) {
      const providerIds = await this.redis.smembers(this.redisCooldownProvidersKey(poolId));
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
        ...providerIds.map((providerId) => this.redisCooldownKey(poolId, providerId)),
      )) as Array<string | null>;
      for (let index = 0; index < providerIds.length; index += 1) {
        const providerId = providerIds[index];
        if (providerId === undefined) continue;
        const raw = raws[index] ?? null;
        const entry = raw ? parseCooldownEntry(raw) : undefined;
        if (!entry) {
          if (raw) await this.redis.del(this.redisCooldownKey(poolId, providerId));
          await this.redis.srem(this.redisCooldownProvidersKey(poolId), providerId);
          continue;
        }
        if (entry.poolId === poolId && now < entry.until) active.set(entry.providerId, entry);
        else await this.redis.srem(this.redisCooldownProvidersKey(poolId), providerId);
      }
    }

    return [...active.values()];
  }
  async clearProviderCooldown(poolId: string, providerId: string): Promise<void> {
    this.cooldowns.delete(this.cooldownKey(poolId, providerId));
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
      NetworkPoolSelector.COOLDOWN_CLEAR_SCRIPT,
      2,
      this.redisCooldownKey(poolId, providerId),
      this.redisCooldownProvidersKey(poolId),
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
    for (const key of [...this.cooldowns.keys()]) {
      if (key.startsWith(`${poolId}::`)) this.cooldowns.delete(key);
    }
    if (!this.redis) return;
    const indexKey = this.redisCooldownProvidersKey(poolId);
    const providerIds = await this.redis.smembers(indexKey);
    for (const providerId of providerIds) {
      await this.redis.del(this.redisCooldownKey(poolId, providerId));
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
        const rotationStart = this.rotationStart(rotation.key, scored.length);
        for (let offset = 0; offset < scored.length; offset += 1) {
          const absolute = (rotationStart + offset) % scored.length;
          const candidate = scored[absolute];
          if (!candidate) continue;
          if (this.getInflight(candidate.poolId) >= candidate.capacity) continue;
          const slot = this.acquire(candidate.poolId, candidate.capacity);
          if (!slot.acquired) continue;
          this.advanceRotation(rotation.key, scored.length, absolute, rotation.rotateCount);
          return { poolId: candidate.poolId, release: slot.release };
        }
        return undefined;
      }
      let bestPool: (typeof scored)[number] | undefined;
      let minRatio = Number.POSITIVE_INFINITY;
      const start = this.fairnessCursor++ % scored.length;
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
    const withCounts = await Promise.all(
      scored.map(async (candidate) => {
        const raw = await redis.get(this.redisInflightKey(candidate.poolId));
        const count = raw === null ? 0 : Number(raw);
        if (!Number.isFinite(count) || count < 0) {
          throw new Error(`invalid pool inflight counter: ${candidate.poolId}`);
        }
        return {
          ...candidate,
          count,
          ratio: count / (candidate.capacity * candidate.weight),
        };
      }),
    );
    // Original (pre-sort) index = absolute rotation position and
    // deterministic tie-breaking.
    const absoluteIndex = new Map(withCounts.map((candidate, index) => [candidate.poolId, index]));
    if (rotation) {
      // Round robin orders strictly by the tenant cursor; the CAS admit below
      // still enforces capacity, so a full pool falls through to the next
      // offset exactly like account failover.
      const rotationStart = this.rotationStart(rotation.key, withCounts.length);
      withCounts.sort(
        (left, right) =>
          (((absoluteIndex.get(left.poolId) ?? 0) - rotationStart + withCounts.length) %
            withCounts.length) -
          (((absoluteIndex.get(right.poolId) ?? 0) - rotationStart + withCounts.length) %
            withCounts.length),
      );
    } else {
      const start = this.fairnessCursor++ % withCounts.length;
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
        this.redisInflightKey(candidate.poolId),
        String(candidate.capacity),
        String(poolInflightTtlSeconds()),
      );
      if (result !== 1) continue;
      if (rotation) {
        this.advanceRotation(
          rotation.key,
          withCounts.length,
          absoluteIndex.get(candidate.poolId) ?? 0,
          rotation.rotateCount,
        );
      }
      this.enforceInflightLimit();
      this.inflight.set(candidate.poolId, this.getInflight(candidate.poolId) + 1);
      this.notifyPoolUsage();
      let released = false;
      return {
        poolId: candidate.poolId,
        release: () => {
          if (released) return;
          released = true;
          const local = this.getInflight(candidate.poolId);
          if (local <= 1) this.inflight.delete(candidate.poolId);
          else this.inflight.set(candidate.poolId, local - 1);
          this.notifyPoolUsage();
          void redisEvalNumber(redis, POOL_RELEASE_SCRIPT, 1, this.redisInflightKey(candidate.poolId)).catch(
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
      const pools = await Promise.all(
        eligiblePoolIds.map(async (poolId): Promise<PoolCapacitySnapshot> => {
          const cooldown = await this.isProviderCooldown(poolId, providerId);
          const maxInflight = effectiveConcurrency(
            limitsByPool?.[poolId] ?? DEFAULT_PROXY_CONCURRENCY,
          );
          const weight = normalizedWeight(weightsByPool?.[poolId]);
          const currentInflight = await this.getInflightAuthoritative(poolId);
          return {
            poolId,
            maxInflight,
            currentInflight,
            available: Math.max(0, maxInflight - currentInflight),
            weight,
            ...(cooldown.resetsAt ? { retryAt: cooldown.resetsAt.getTime() } : {}),
          };
        }),
      );
      const cooldowns = await Promise.all(
        eligiblePoolIds.map((poolId) => this.isProviderCooldown(poolId, providerId)),
      );
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
