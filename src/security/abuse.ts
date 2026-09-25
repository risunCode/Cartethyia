import { GatewayError } from "../transport/gateway-error";
import { redisEvalTuple, type RedisClient } from "../persistence/redis";

export interface ClientIdentity {
  readonly address: string;
  readonly source: "tcp-peer" | "trusted-forwarded-header";
}

/**
 * Decodes the `{banned, count, bannedNow}` tuple the admission script returns.
 *
 * The script is the only producer, so a value that is not three elements or
 * whose members are not finite numbers means the script/response pair drifted
 * (a desynced deployment, a cluster resharding mid-eval). Reading such a value
 * as a counter would silently admit or reject on garbage, so it throws instead
 * — the caller maps that to the bounded `admission_unavailable` it already uses
 * for an unreachable store.
 */
function decodeAbuseOutcome(raw: readonly unknown[]): IpAbuseOutcome {
  if (raw.length !== 3) {
    throw new Error(`[abuse] admission script returned ${raw.length} elements, expected 3`);
  }
  const [bannedRaw, countRaw, bannedNowRaw] = raw.map((value) => Number(value));
  const banned = bannedRaw ?? NaN;
  const count = countRaw ?? NaN;
  const bannedNow = bannedNowRaw ?? NaN;
  if (!Number.isFinite(banned) || !Number.isFinite(count) || !Number.isFinite(bannedNow)) {
    throw new Error(`[abuse] admission script returned a non-finite value: ${String(raw)}`);
  }
  return { banned: banned === 1, count, bannedNow: bannedNow === 1 };
}

/**
 * Route slot the identity-wide ban counter is stored under.
 *
 * A real route can never collide with it: `/v1/*` paths always begin with a
 * slash and this literal does not, so no client-supplied path can alias the
 * escalation counter into its own per-route window.
 */
const BAN_ROUTE_KEY = "#ban";

/**
 * One admission step, as the store sees it.
 *
 * Both counters are derived here so the store can record them in one
 * operation: `limit` sizes the per-route window (which must be able to report
 * `limit + 1`, since a count above the limit is otherwise unrepresentable) and
 * `banThreshold` is both the identity-wide escalation threshold and the
 * highest count either ring must keep observable.
 */
export interface IpAbuseAttempt {
  readonly identity: string;
  readonly route: string;
  readonly now: number;
  readonly limit: number;
  readonly banThreshold: number;
  readonly banDurationMs: number;
}

/** What one admission step decided. */
export interface IpAbuseOutcome {
  /** The identity was already banned; nothing was incremented. */
  readonly banned: boolean;
  /** Attempts now in this route's window, including this one. `0` when banned. */
  readonly count: number;
  /** This attempt crossed the ban threshold, so the ban was recorded. */
  readonly bannedNow: boolean;
}

export interface IpAbuseStore {
  /**
   * One atomic admission + escalation step: reads the ban, records the attempt
   * against both the per-route window and the identity-wide escalation
   * counter, and records the ban when the threshold is crossed.
   *
   * **One method, not four, because the Redis store pays a round trip per
   * call.** The gateway runs this on every `/v1/*` request, so a
   * read-then-increment-then-escalate sequence cost three round trips on the
   * admitted path and four once a ban fired. The store must therefore decide
   * and record in a single operation; both implementations do.
   *
   * **Two counters, and both are needed.** The window that admits or rejects a
   * request is per `(identity, route)`, so a busy route cannot spend another
   * route's budget — a client streaming chat completions does not lose its
   * ability to call `/v1/models`. The escalation counter is per identity
   * alone, because a ban is: keying escalation by route let a caller spread the
   * same volume across paths and never reach the threshold, since each route's
   * count stayed low. Collapsing them either breaks per-route fairness or
   * leaves the ban evadable by rotating the path.
   *
   * Fail-closed: an unreachable store throws, and the caller maps that to a
   * bounded `admission_unavailable` with zero dispatches.
   */
  checkAndRecord(attempt: IpAbuseAttempt): Promise<IpAbuseOutcome>;
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
   * {@link checkAndRecord}'s return value, so this is not part of the store
   * contract and the Redis store has no equivalent.
   */
  async getCount(identity: string, route: string, now = this.clock()): Promise<number> {
    this.assertAvailable();
    const counter = this.counts.get(this.key(identity, route));
    if (!counter) return 0;
    counter.prune(now - this.windowMs);
    return counter.count();
  }

  /**
   * Whether `identity` is currently banned. In-memory-only introspection for
   * tests, mirroring {@link getCount}: the service learns this from
   * {@link checkAndRecord}'s `banned` flag, so it is not part of the contract.
   */
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

  async checkAndRecord(attempt: IpAbuseAttempt): Promise<IpAbuseOutcome> {
    this.assertAvailable();
    const { identity, route, now, limit, banThreshold, banDurationMs } = attempt;

    // The ban is read first and, when live, short-circuits: a banned identity
    // records nothing, so it can neither extend its own counters nor defer the
    // ban it already earned.
    const until = this.bans.get(identity);
    if (until !== undefined) {
      if (until > now) return { banned: true, count: 0, bannedNow: false };
      this.bans.delete(identity);
    }

    const window = this.getOrCreate(
      this.counts,
      this.key(identity, route),
      Math.max(this.capacityPerKey, limit + 1),
    );
    window.prune(now - this.windowMs);
    // Grow only for keys that actually exceed the base ring: a well-behaved
    // client never allocates past `capacityPerKey`, while a key that keeps
    // hammering past the limit can still count up to the ban threshold.
    if (window.count() >= window.capacity) window.reserve(banThreshold);
    window.push(now);
    const count = window.count();

    // Escalation counts every attempt against one identity-wide ring, so
    // spreading the same volume over many paths cannot keep each route's count
    // below the threshold.
    const banCounter = this.getOrCreate(
      this.banCounts,
      this.key(identity, BAN_ROUTE_KEY),
      banThreshold,
    );
    banCounter.prune(now - this.windowMs);
    banCounter.push(now);
    const bannedNow = banCounter.count() >= banThreshold;
    if (bannedNow) {
      // Bans are keyed by identity alone, so the same bound applies: expired
      // entries are only dropped when their identity is looked up again, which
      // a rotating fan-out never does.
      this.evictOldest(this.bans);
      this.bans.set(identity, now + banDurationMs);
    }
    return { banned: false, count, bannedNow };
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
      // One atomic step: the store reads the ban, records this attempt against
      // both the per-route window and the identity-wide escalation counter, and
      // records the ban if the threshold is crossed. Concurrent callers cannot
      // race past the limit, and rejected attempts keep counting toward the ban
      // instead of being silently dropped.
      const outcome = await this.store.checkAndRecord({
        identity: ip,
        route: input.route,
        now,
        limit: this.maxRequestsPerWindow,
        banThreshold: this.banThreshold,
        banDurationMs: this.banDurationMs,
      });

      if (outcome.banned) {
        throw new GatewayError("quota_exceeded", 429, "ip banned", {
          reason: "admission-unavailable",
          ip,
          route: input.route,
        });
      }

      if (outcome.count > this.maxRequestsPerWindow) {
        throw new GatewayError("quota_exceeded", 429, "ip rate limit exceeded", {
          reason: "admission-unavailable",
          ip,
          route: input.route,
          count: outcome.count,
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

/**
 * The one admission + escalation step, as a static Lua script.
 *
 * `KEYS[1]` is the per-route window, `KEYS[2]` the identity-wide escalation
 * counter, `KEYS[3]` the ban. Both counters are sorted sets of
 * `<timestamp>:<uuid>` members, so a burst of attempts inside one millisecond
 * cannot collapse into a single member and undercount.
 *
 * `ARGV`: 1 now(ms), 2 windowMs, 3 limit, 4 banThreshold, 5 banDurationMs,
 * 6 per-route member, 7 escalation member.
 *
 * Returns a `{banned, count, bannedNow}` tuple. The ban is read first and
 * short-circuits without writing, so a banned identity cannot keep extending
 * its own counters. Both rings are trimmed to `banThreshold` members so an
 * abusive key cannot grow them without bound. The ban key carries the ban
 * duration as its TTL, so an expired ban needs no sweeper.
 */
const IP_ADMISSION_SCRIPT = `
  local banned = redis.call('GET', KEYS[3])
  if banned and tonumber(banned) > tonumber(ARGV[1]) then
    return {1, 0, 0}
  end
  redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, tonumber(ARGV[1]) - tonumber(ARGV[2]))
  local count = redis.call('ZCARD', KEYS[1])
  redis.call('ZADD', KEYS[1], ARGV[1], ARGV[6])
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  if count >= tonumber(ARGV[4]) then
    redis.call('ZREMRANGEBYRANK', KEYS[1], 0, count - tonumber(ARGV[4]))
  end
  redis.call('ZREMRANGEBYSCORE', KEYS[2], 0, tonumber(ARGV[1]) - tonumber(ARGV[2]))
  local banCount = redis.call('ZCARD', KEYS[2])
  redis.call('ZADD', KEYS[2], ARGV[1], ARGV[7])
  redis.call('PEXPIRE', KEYS[2], ARGV[2])
  if banCount >= tonumber(ARGV[4]) then
    redis.call('ZREMRANGEBYRANK', KEYS[2], 0, banCount - tonumber(ARGV[4]))
  end
  local bannedNow = 0
  if banCount + 1 >= tonumber(ARGV[4]) then
    redis.call('SET', KEYS[3], tonumber(ARGV[1]) + tonumber(ARGV[5]), 'PX', ARGV[5])
    bannedNow = 1
  end
  return {0, count + 1, bannedNow}
`;

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
  /** The ban marker; its value is the ban's expiry and its TTL is the duration. */
  private banMarkerKey(identity: string): string {
    return `cartethyia:ip:ban:${identity}`;
  }

  async checkAndRecord(attempt: IpAbuseAttempt): Promise<IpAbuseOutcome> {
    const { identity, route, now, limit, banThreshold, banDurationMs } = attempt;
    const raw = await redisEvalTuple(
      this.redis,
      IP_ADMISSION_SCRIPT,
      3,
      this.key(identity, route),
      this.banKey(identity),
      this.banMarkerKey(identity),
      String(now),
      String(this.windowMs),
      String(limit),
      String(banThreshold),
      String(Math.max(1, banDurationMs)),
      `${now}:${crypto.randomUUID()}`,
      `${now}:${crypto.randomUUID()}`,
    );
    return decodeAbuseOutcome(raw);
  }
}

