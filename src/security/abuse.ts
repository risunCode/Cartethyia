import { GatewayError } from "../transport/gateway-error";
import { redisEvalNumber, type RedisClient } from "../persistence/redis";

export interface ClientIdentity {
  readonly address: string;
  readonly source: "tcp-peer" | "trusted-forwarded-header";
}

/**
 * Route slot the identity-wide ban counter is stored under.
 *
 * A real route can never collide with it: `/v1/*` paths always begin with a
 * slash and this literal does not, so no client-supplied path can alias the
 * escalation counter into its own per-route window.
 */
const BAN_ROUTE_KEY = "#ban";

export interface IpAbuseStore {
  isBanned(identity: string, now: number): Promise<boolean>;
  /** Bans `identity` for `durationMs` from `now`; the duration is the service's to decide. */
  recordBan(identity: string, now: number, durationMs: number): Promise<void>;
  /**
   * Atomically records one attempt and returns the number of attempts now in
   * the window, including it.
   *
   * `limit` is the admission cap the store must be able to observe and
   * `ceiling` the highest count that must stay observable for ban escalation
   * (`ceiling > limit`). Both come from the service so one store instance can
   * serve different policies: the window holds at least `limit + 1` entries
   * (a count above `limit` is otherwise unrepresentable) and grows up to
   * `ceiling` for keys that keep exceeding the limit.
   */
  checkAndIncrement(
    identity: string,
    route: string,
    now: number,
    limit: number,
    ceiling: number,
  ): Promise<number>;
  /**
   * Records one attempt against the identity's **ban** counter and returns the
   * count now in the window, including it.
   *
   * Deliberately separate from {@link checkAndIncrement}: that one is keyed by
   * `(identity, route)` so routes keep independent admission budgets, while
   * escalation must be identity-wide. A single per-route counter cannot do
   * both — keying escalation by route let a caller rotate paths and keep every
   * count below the threshold, and keying admission by identity would let one
   * busy route exhaust a client's whole budget.
   *
   * `ceiling` is the highest count that must stay representable, so the ring
   * can grow to the ban threshold the same way the admission counter does.
   */
  recordBanCandidate(identity: string, now: number, ceiling: number): Promise<number>;
}

export interface IpAbuseProtectionServiceOptions {
  readonly maxRequestsPerWindow?: number;
  readonly banThreshold?: number;
  readonly banDurationMs?: number;
}

export interface InMemoryIpAbuseStoreOptions {
  readonly windowMs?: number;
  readonly clock?: () => number;
  /** Distinct (identity, route) keys tracked before the oldest is evicted. */
  readonly maxKeys?: number;
  /** Slots preallocated per key; the ring still grows to the ban ceiling for
   *  keys that keep exceeding the admission limit. */
  readonly capacityPerKey?: number;
}

/** Bounded circular buffer of recent request timestamps.
 *  Capacity is the highest count the window must be able to report: once full
 *  the oldest slot is overwritten in O(1), and `reserve` grows the ring for
 *  keys that keep exceeding the admission limit (ban escalation needs counts
 *  above the cap). Sweep is amortized against `push` — no full-map scan on
 *  every incoming request. */
class RingCounter {
  private buf: Float64Array;
  private head = 0;
  private tail = 0;
  private size = 0;
  /** Slots in the ring — the highest count the window can report. */
  capacity: number;
  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
    this.buf = new Float64Array(this.capacity);
  }
  /** Grows the ring in place, preserving the live entries in age order. */
  reserve(capacity: number): void {
    if (capacity <= this.capacity) return;
    const next = new Float64Array(capacity);
    for (let index = 0; index < this.size; index += 1) {
      next[index] = this.buf[(this.head + index) % this.buf.length]!;
    }
    this.buf = next;
    this.capacity = capacity;
    this.head = 0;
    this.tail = this.size % next.length;
  }
  /** Drops expired entries. O(k) where k is only what actually expired. */
  prune(cutoff: number): void {
    while (this.size > 0 && this.buf[this.head]! <= cutoff) {
      this.head = (this.head + 1) % this.buf.length;
      this.size -= 1;
    }
  }
  count(): number {
    return this.size;
  }
  push(now: number): void {
    this.buf[this.tail] = now;
    this.tail = (this.tail + 1) % this.buf.length;
    if (this.size < this.buf.length) this.size += 1;
    else this.head = (this.head + 1) % this.buf.length;
  }
}

/** In-memory abuse store with O(1) per-key sliding-window counters and
 *  bounded cardinality. Sweeps expired bans lazily on the touched key
 *  instead of scanning the whole map on every request — the previous
 *  behavior turned into an O(N) hot spot at 10k inflight. */
export class InMemoryIpAbuseStore implements IpAbuseStore {
  private counts = new Map<string, RingCounter>();
  private banCounts = new Map<string, RingCounter>();
  private bans = new Map<string, number>();
  private failing = false;
  private readonly windowMs: number;
  private readonly clock: () => number;
  private readonly maxKeys: number;
  private readonly capacityPerKey: number;

  constructor(windowOrOptions: number | InMemoryIpAbuseStoreOptions = 60_000) {
    const options =
      typeof windowOrOptions === "number" ? { windowMs: windowOrOptions } : windowOrOptions;
    this.windowMs = options.windowMs ?? 60_000;
    this.clock = options.clock ?? (() => Date.now());
    // 10k keys is a few MB even at the default 240 RPM ring size; the previous
    // 100k bound could reach ~190 MB, and a fan-out over unique source IPs is
    // the one input that can actually reach it.
    this.maxKeys = options.maxKeys ?? 10_000;
    // Sizes only the well-behaved path: a key that exceeds the admission limit
    // still grows its ring to the ban ceiling, so a smaller preallocation
    // cannot make a count above `limit` unrepresentable.
    this.capacityPerKey = options.capacityPerKey ?? 64;
  }

  simulateFailure(failing: boolean): void {
    this.failing = failing;
  }

  /** Distinct keys currently tracked; sampled as a memory gauge. */
  keyCount(): number {
    return this.counts.size;
  }

  private key(identity: string, route: string): string {
    return `${identity}::${route}`;
  }

  /** Evicts the oldest entries of `map` down to `maxKeys` in a single pass so
   *  an adversarial fan-out over unique identities cannot pin memory. Deleting
   *  one entry at a time was O(1) but starved reclaim. */
  private evictOldest<K, V>(map: Map<K, V>): void {
    if (map.size < this.maxKeys) return;
    let toEvict = map.size - this.maxKeys + 1;
    for (const key of map.keys()) {
      if (toEvict-- <= 0) break;
      map.delete(key);
    }
  }

  private getOrCreate(
    map: Map<string, RingCounter>,
    key: string,
    capacity: number,
  ): RingCounter {
    let counter = map.get(key);
    if (!counter) {
      this.evictOldest(map);
      counter = new RingCounter(capacity);
      map.set(key, counter);
    }
    return counter;
  }

  /**
   * Outage injection for tests, mirroring the store's own reachability.
   *
   * The service no longer probes the store before using it: every method below
   * throws when the store is unreachable, and the service's catch maps that to
   * a bounded `admission_unavailable`. Keeping a separate probe would only add
   * a round trip to every request on the Redis store.
   */
  private assertAvailable(): void {
    if (this.failing) throw new Error("ip store unavailable");
  }

  /**
   * Attempts currently inside the sliding window for one (identity, route).
   *
   * In-memory-only introspection: the service reads counts from
   * `checkAndIncrement`'s return value, so this is not part of the store
   * contract and the Redis store has no equivalent.
   */
  async getCount(identity: string, route: string, now = this.clock()): Promise<number> {
    this.assertAvailable();
    const counter = this.counts.get(this.key(identity, route));
    if (!counter) return 0;
    counter.prune(now - this.windowMs);
    return counter.count();
  }

  async checkAndIncrement(
    identity: string,
    route: string,
    now: number,
    limit: number,
    ceiling: number,
  ): Promise<number> {
    this.assertAvailable();
    const counter = this.getOrCreate(
      this.counts,
      this.key(identity, route),
      Math.max(this.capacityPerKey, limit + 1),
    );
    counter.prune(now - this.windowMs);
    // Grow only for keys that actually exceed the base ring: a well-behaved
    // client never allocates past `capacityPerKey`, while a key that keeps
    // hammering past the limit can still count up to the ban threshold.
    if (counter.count() >= counter.capacity) counter.reserve(ceiling);
    counter.push(now);
    return counter.count();
  }

  async recordBanCandidate(identity: string, now: number, ceiling: number): Promise<number> {
    this.assertAvailable();
    const key = this.key(identity, BAN_ROUTE_KEY);
    const counter = this.getOrCreate(this.banCounts, key, ceiling);
    counter.prune(now - this.windowMs);
    counter.push(now);
    return counter.count();
  }

  async isBanned(identity: string, now = this.clock()): Promise<boolean> {
    this.assertAvailable();
    const until = this.bans.get(identity);
    if (until === undefined) return false;
    if (until <= now) {
      this.bans.delete(identity);
      return false;
    }
    return true;
  }

  async recordBan(identity: string, now: number, durationMs: number): Promise<void> {
    this.assertAvailable();
    // Bans are keyed by identity alone, so the same bound applies: expired
    // entries are only dropped when their identity is looked up again, which
    // a rotating fan-out never does.
    this.evictOldest(this.bans);
    this.bans.set(identity, now + durationMs);
  }
}

/**
 * Per-IP rate-limit/ban layer for `/v1/*` gateway routes.
 *
 * Independent of ApiKeyAdmissionService: the ingress middleware skips
 * `/health`, `/health/ready` and everything outside `/v1/*`, and console auth
 * is covered by its own DB-persisted ConsoleLockoutService.
 *
 * **Two counters, and both are needed.** The window that admits or rejects a
 * request is per `(identity, route)`, so a busy route cannot spend another
 * route's budget — a client streaming chat completions does not lose its
 * ability to call `/v1/models`. The ban counter is per identity alone,
 * because a ban is: keying escalation by route let a caller spread the same
 * volume across paths and never reach the threshold, since each route's count
 * stayed low. The two are separate on purpose — one decides admission, the
 * other decides escalation, and collapsing them either breaks per-route
 * fairness or leaves the ban evadable by rotating the path.
 *
 * Fail-closed on store outage: bounded `admission_unavailable`, zero
 * dispatches.
 */
export class IpAbuseProtectionService {
  private readonly maxRequestsPerWindow: number;
  private readonly banThreshold: number;
  private readonly banDurationMs: number;

  constructor(
    private readonly store: IpAbuseStore,
    private readonly clock: () => number = () => Date.now(),
    opts: IpAbuseProtectionServiceOptions = {},
  ) {
    if (!store)
      throw new Error("IpAbuseProtectionService requires a store — fail-closed, not no-op");
    // 240 requests per 60 s window = 4 RPS/IP steady-state cap. Aligns
    // with the documented default: unset env → 240 RPM per IP, not
    // unlimited. Operators raise or lower via IP_RATE_MAX_PER_WINDOW.
    this.maxRequestsPerWindow = opts.maxRequestsPerWindow ?? 240;
    // A ban only makes sense once the limit was breached, so the threshold is
    // clamped above the cap: below it, escalation would be unreachable (the
    // count can never exceed `maxRequestsPerWindow` without being rejected).
    this.banThreshold = Math.max(opts.banThreshold ?? 480, this.maxRequestsPerWindow + 1);
    this.banDurationMs = opts.banDurationMs ?? 60 * 60 * 1000;
  }

  async checkBeforeAccess(input: {
    readonly identity: ClientIdentity;
    readonly route: string;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    if (input.signal?.aborted) {
      throw new GatewayError("admission_unavailable", 503, "ip check aborted", {
        reason: "admission-unavailable",
      });
    }
    const now = this.clock();
    const ip = input.identity.address;

    try {
      const banned = await this.store.isBanned(ip, now);
      if (banned) {
        throw new GatewayError("quota_exceeded", 429, "ip banned", {
          reason: "admission-unavailable",
          ip,
          route: input.route,
        });
      }

      // Atomic check-and-increment: the store records this attempt and
      // returns the window count including it, so concurrent callers cannot
      // race past the limit and rejected attempts keep counting toward the
      // ban threshold instead of being silently dropped.
      const count = await this.store.checkAndIncrement(
        ip,
        input.route,
        now,
        this.maxRequestsPerWindow,
        this.banThreshold,
      );

      // Escalation is counted across every route the identity touched, so
      // spreading the same volume over many paths cannot keep each count low
      // and dodge the ban. Recorded on every attempt, not only the rejected
      // ones: the threshold is a total-volume bound, and an attacker whose
      // attempts mostly succeed is still abusing the gateway.
      const banCount = await this.store.recordBanCandidate(
        ip,
        now,
        this.banThreshold,
      );
      if (banCount >= this.banThreshold) {
        try {
          await this.store.recordBan(ip, now, this.banDurationMs);
        } catch {
          // store outage during ban recording is still fail-closed
          throw new GatewayError(
            "admission_unavailable",
            503,
            "ip store unavailable during ban",
            {
              reason: "admission-unavailable",
            },
          );
        }
      }

      if (count > this.maxRequestsPerWindow) {
        throw new GatewayError("quota_exceeded", 429, "ip rate limit exceeded", {
          reason: "admission-unavailable",
          ip,
          route: input.route,
          count,
        });
      }
    } catch (err) {
      if (err instanceof GatewayError) throw err;
      throw new GatewayError("admission_unavailable", 503, "ip abuse store error", {
        reason: "admission-unavailable",
        cause: (err as Error).message,
      });
    }
  }
}

export class RedisIpAbuseStore implements IpAbuseStore {
  constructor(
    private readonly redis: RedisClient,
    private readonly windowMs = 60_000,
  ) {}
  private key(identity: string, route: string): string {
    return `cartethyia:ip:${identity}:${route}`;
  }
  /** Identity-wide escalation counter; distinct prefix from the per-route key. */
  private banKey(identity: string): string {
    return `cartethyia:ip:ban-count:${identity}`;
  }
  async checkAndIncrement(
    identity: string,
    route: string,
    now: number,
    _limit: number,
    ceiling: number,
  ): Promise<number> {
    const key = this.key(identity, route);
    // Records every attempt (including rejected ones) and trims the set back
    // to `ceiling` members so an abusive key cannot grow it without bound.
    const lua = `
      redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[1] - ARGV[2])
      local count = redis.call('ZCARD', KEYS[1])
      redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
      redis.call('PEXPIRE', KEYS[1], ARGV[2])
      if count >= tonumber(ARGV[3]) then
        redis.call('ZREMRANGEBYRANK', KEYS[1], 0, count - tonumber(ARGV[3]))
      end
      return count + 1
    `;
    const member = `${now}:${crypto.randomUUID()}`;
    return redisEvalNumber(this.redis, lua, 1, key, String(now), String(this.windowMs), String(ceiling), member);
  }
  async recordBanCandidate(identity: string, now: number, ceiling: number): Promise<number> {
    // One sorted set per identity, shared by every route it touches, so the
    // count is the identity's total volume rather than one path's.
    const key = this.banKey(identity);
    const lua = `
      redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[1] - ARGV[2])
      local count = redis.call('ZCARD', KEYS[1])
      redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
      redis.call('PEXPIRE', KEYS[1], ARGV[2])
      if count >= tonumber(ARGV[3]) then
        redis.call('ZREMRANGEBYRANK', KEYS[1], 0, count - tonumber(ARGV[3]))
      end
      return count + 1
    `;
    const member = `${now}:${crypto.randomUUID()}`;
    return redisEvalNumber(
      this.redis,
      lua,
      1,
      key,
      String(now),
      String(this.windowMs),
      String(ceiling),
      member,
    );
  }
  async isBanned(identity: string, now: number): Promise<boolean> {
    const value = await this.redis.get(`cartethyia:ip:ban:${identity}`);
    return value !== null && Number(value) > now;
  }
  async recordBan(identity: string, now: number, durationMs: number): Promise<void> {
    await this.redis.set(
      `cartethyia:ip:ban:${identity}`,
      String(now + durationMs),
      "PX",
      Math.max(1, durationMs),
    );
  }
}
