/**
 * Model-abuse strikes: a graduated response to a client that repeatedly asks
 * for a model it may not use.
 *
 * A gateway request names a model; when that name is outside the key's
 * allowlist, denylisted, or resolves to nothing, the request is rejected 404
 * `model_not_found`. That rejection is a normal answer to one mistake — but a
 * client that keeps hitting it is not making a mistake, it is probing, and it
 * costs the operator real work: every attempt lands as a failed row in the
 * console and the share page, burying the traffic that matters.
 *
 * So the rejection escalates. Each *consecutive* invalid-model attempt records
 * a strike against the caller's client IP; crossing the threshold bans that IP.
 * A valid-model request resets the counter, and a strike counter expires on its
 * own after a quiet window, so a single typo — or an honest client that
 * corrected itself — never accumulates toward a ban.
 *
 * **The ban is keyed on the client address alone.** Keying it on the API key
 * too was the wrong trade: a key is shared by everyone behind a template (every
 * recipient of a share link, every member of a team), so banning the key
 * punishes callers that did nothing while the address that actually probed
 * walks away and mints a fresh key. The address is the identity that cannot be
 * re-enrolled, which is the whole point of the escalation.
 *
 * **A ban lapses after a fixed TTL** (default 1 h, `CARTETHYIA_MODEL_BAN_TTL_MS`)
 * rather than staying until an operator lifts it, so a false positive — a shared
 * NAT, an office behind one egress — heals without human intervention. The
 * console can still lift one early, which is the escape hatch when an operator
 * wants a caller back immediately.
 *
 * Fail-open on store outage: unlike admission (where admitting an unauthorized
 * request is worse than refusing a valid one), a strike layer that cannot read
 * its counter must not refuse a legitimate request. A store error is swallowed
 * and the request proceeds; the worst case is a missed strike, never a blocked
 * client.
 */
import { GatewayError } from "../transport/gateway-error";
import { redisEvalTuple, type RedisClient } from "../persistence/redis";

/** A ban row, for the console. */
export interface ModelAbuseBan {
  /** The client address the ban is keyed on. */
  readonly ip: string;
  /** Epoch ms the ban lapses on its own. */
  readonly expiresAt: number;
}

/** One strike decision, as the store sees it. */
export interface ModelAbuseAttempt {
  readonly ip: string;
  /** Whether this attempt named a model the key may use. */
  readonly valid: boolean;
  /** Consecutive invalid attempts that trigger a ban. */
  readonly threshold: number;
  /** Quiet window (ms) after which a strike counter expires. */
  readonly windowMs: number;
  /** How long (ms) a ban lasts before it lapses on its own. */
  readonly banTtlMs: number;
}

/** What one strike decision decided. */
export interface ModelAbuseOutcome {
  /** The IP is banned, now or already. */
  readonly banned: boolean;
  /** Consecutive invalid attempts against the IP, after this one. `0` when valid. */
  readonly strikes: number;
  /** This attempt crossed the threshold and recorded the ban. */
  readonly bannedNow: boolean;
}

/**
 * The `{banned, strikes, bannedNow}` tuple the script returns. A value of the
 * wrong length or with a non-finite member means the script and its caller
 * drifted; reading it as a decision would ban or admit on garbage, so it
 * throws — the service maps that to a swallowed fail-open, never a rejection.
 */
function decodeOutcome(raw: readonly unknown[]): ModelAbuseOutcome {
  if (raw.length !== 3) {
    throw new Error(`[model-abuse] script returned ${raw.length} elements, expected 3`);
  }
  const [bannedRaw, strikesRaw, bannedNowRaw] = raw.map((value) => Number(value));
  const banned = bannedRaw ?? NaN;
  const strikes = strikesRaw ?? NaN;
  const bannedNow = bannedNowRaw ?? NaN;
  if (!Number.isFinite(banned) || !Number.isFinite(strikes) || !Number.isFinite(bannedNow)) {
    throw new Error(`[model-abuse] script returned a non-finite value: ${String(raw)}`);
  }
  return { banned: banned === 1 || bannedNow === 1, strikes, bannedNow: bannedNow === 1 };
}

export interface ModelAbuseStore {
  /**
   * One atomic strike decision: reads the ban, records the attempt against the
   * IP counter (or clears it on a valid attempt), and records a ban when the
   * counter reaches the threshold.
   */
  record(attempt: ModelAbuseAttempt): Promise<ModelAbuseOutcome>;
  /** O(1) ban lookup for the pre-parse gate. */
  isBanned(ip: string): Promise<boolean>;
  /** Every active ban, for the console. */
  listBans(): Promise<readonly ModelAbuseBan[]>;
  /** Lifts one ban. Returns whether a ban existed. */
  unban(ip: string): Promise<boolean>;
}

interface InMemoryOptions {
  readonly maxKeys?: number;
}

/**
 * In-memory strike store: one consecutive counter and one ban map.
 *
 * The counter is a `<count, expiresAt>` pair, so a quiet window expires a strike
 * without a sweeper; a ban carries the instant it lapses and is swept lazily on
 * the next read of that address. Bounded by `maxKeys` on the counter map (oldest
 * evicted) so an adversarial fan-out over unique addresses cannot pin memory;
 * the ban map is bounded by the abuse itself, since each entry cost a full
 * threshold of attempts, and entries leave when their TTL lapses.
 */
export class InMemoryModelAbuseStore implements ModelAbuseStore {
  private readonly strikes = new Map<string, { count: number; expiresAt: number }>();
  private readonly bans = new Map<string, number>();
  private readonly maxKeys: number;

  constructor(private readonly clock: () => number = () => Date.now(), opts: InMemoryOptions = {}) {
    this.maxKeys = opts.maxKeys ?? 10_000;
  }

  private evictOldest(): void {
    if (this.strikes.size < this.maxKeys) return;
    let toEvict = this.strikes.size - this.maxKeys + 1;
    for (const key of this.strikes.keys()) {
      if (toEvict-- <= 0) break;
      this.strikes.delete(key);
    }
  }

  /** The live ban's expiry, or `undefined`; an elapsed ban is dropped. */
  private banExpiry(ip: string, now: number): number | undefined {
    const expiresAt = this.bans.get(ip);
    if (expiresAt === undefined) return undefined;
    if (expiresAt <= now) {
      this.bans.delete(ip);
      return undefined;
    }
    return expiresAt;
  }

  async record(attempt: ModelAbuseAttempt): Promise<ModelAbuseOutcome> {
    const now = this.clock();
    const { ip, valid, threshold, windowMs, banTtlMs } = attempt;

    if (this.banExpiry(ip, now) !== undefined)
      return { banned: true, strikes: 0, bannedNow: false };

    if (valid) {
      this.strikes.delete(ip);
      return { banned: false, strikes: 0, bannedNow: false };
    }

    const entry = this.strikes.get(ip);
    const current = entry === undefined || entry.expiresAt <= now ? 0 : entry.count;
    const strikes = current + 1;
    this.evictOldest();
    this.strikes.set(ip, { count: strikes, expiresAt: now + windowMs });
    if (strikes >= threshold) {
      this.bans.set(ip, now + banTtlMs);
      return { banned: true, strikes, bannedNow: true };
    }
    return { banned: false, strikes, bannedNow: false };
  }

  async listBans(): Promise<readonly ModelAbuseBan[]> {
    const now = this.clock();
    const bans: ModelAbuseBan[] = [];
    for (const [ip, expiresAt] of [...this.bans]) {
      if (expiresAt <= now) this.bans.delete(ip);
      else bans.push({ ip, expiresAt });
    }
    return bans;
  }

  async isBanned(ip: string): Promise<boolean> {
    return this.banExpiry(ip, this.clock()) !== undefined;
  }

  async unban(ip: string): Promise<boolean> {
    return this.bans.delete(ip);
  }
}

/**
 * The one strike decision, as a static Lua script.
 *
 * `KEYS[1]` the IP strike counter, `KEYS[2]` the ban sorted set. `ARGV`: 1
 * valid(`1`/`0`), 2 windowMs, 3 ip, 4 now (epoch ms), 5 threshold, 6 banTtlMs.
 *
 * Returns `{banned, strikes, bannedNow}`. The ban is read first and
 * short-circuits without writing, so a banned address cannot extend its own
 * counter. The counter carries the window as its TTL, so a quiet window expires
 * a strike with no sweeper. A ban is a member of the sorted set scored with the
 * instant it lapses, so it needs no sweeper either: an elapsed member is read as
 * absent and dropped, and `listBans` trims the range. `now` is the caller's
 * clock rather than the server's so the in-memory and Redis stores age a ban
 * identically.
 */
const MODEL_ABUSE_SCRIPT = `
  local score = redis.call('ZSCORE', KEYS[2], ARGV[3])
  if score then
    if tonumber(score) > tonumber(ARGV[4]) then
      return {1, 0, 0}
    end
    redis.call('ZREM', KEYS[2], ARGV[3])
  end
  if ARGV[1] == '1' then
    redis.call('DEL', KEYS[1])
    return {0, 0, 0}
  end
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2])) end
  if count >= tonumber(ARGV[5]) then
    redis.call('ZADD', KEYS[2], tonumber(ARGV[4]) + tonumber(ARGV[6]), ARGV[3])
    return {0, count, 1}
  end
  return {0, count, 0}
`;

export class RedisModelAbuseStore implements ModelAbuseStore {
  constructor(
    private readonly redis: RedisClient,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  private strikeKey(ip: string): string {
    return `cartethyia:model-abuse:strike:ip:${ip}`;
  }
  /**
   * The ban index. It is a sorted set scored with each ban's expiry instant,
   * under a name of its own: the previous permanent-ban *set* cannot be read as
   * a sorted set, and reading it anyway would raise WRONGTYPE on every check.
   * A member from before this change is therefore simply gone — the right
   * outcome, since those bans were recorded without an expiry this store cannot
   * invent.
   */
  private banKey(): string {
    return "cartethyia:model-abuse:bans:ip";
  }

  async record(attempt: ModelAbuseAttempt): Promise<ModelAbuseOutcome> {
    const { ip, valid, threshold, windowMs, banTtlMs } = attempt;
    const raw = await redisEvalTuple(
      this.redis,
      MODEL_ABUSE_SCRIPT,
      2,
      this.strikeKey(ip),
      this.banKey(),
      valid ? "1" : "0",
      String(Math.max(1, windowMs)),
      ip,
      String(this.clock()),
      String(threshold),
      String(Math.max(1, banTtlMs)),
    );
    return decodeOutcome(raw);
  }

  async listBans(): Promise<readonly ModelAbuseBan[]> {
    const now = this.clock();
    await this.redis.zremrangebyscore(this.banKey(), "-inf", String(now));
    const entries = await this.redis.zrange(this.banKey(), "0", "-1", "WITHSCORES");
    const bans: ModelAbuseBan[] = [];
    for (let index = 0; index + 1 < entries.length; index += 2) {
      const ip = entries[index];
      const score = entries[index + 1];
      if (ip === undefined || score === undefined) break;
      bans.push({ ip, expiresAt: Number(score) });
    }
    return bans;
  }

  async isBanned(ip: string): Promise<boolean> {
    const now = this.clock();
    const score = await this.redis.zscore(this.banKey(), ip);
    if (score === null) return false;
    if (Number(score) > now) return true;
    await this.redis.zrem(this.banKey(), ip);
    return false;
  }

  async unban(ip: string): Promise<boolean> {
    const removed = await this.redis.zrem(this.banKey(), ip);
    return Number(removed) > 0;
  }
}

export interface ModelStrikeOptions {
  /** Consecutive invalid-model attempts that trigger a ban. Default 10. */
  readonly threshold?: number;
  /** Quiet window (ms) after which a strike counter expires. Default 5 minutes. */
  readonly windowMs?: number;
  /** How long (ms) a ban lasts before it lapses. Default 1 hour. */
  readonly banTtlMs?: number;
}

/**
 * Graduated model-abuse strikes over a store.
 *
 * `noteInvalid` is the hot path for a rejected model; `noteValid` clears a
 * strike but only writes when this process has actually seen a strike for the
 * address, so a well-behaved client pays nothing. `listBans`/`unban` are the
 * console's escape hatch.
 */
export class ModelStrikeService {
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly _banTtlMs: number;
  /**
   * Addresses this process has recorded a strike for, so `noteValid` can skip
   * the reset write for a client that was never struck. Process-local on
   * purpose: a miss only means a strike survives until its window expires
   * instead of being cleared early, which is the safe direction for abuse.
   */
  private readonly dirty = new Set<string>();

  constructor(private readonly store: ModelAbuseStore, opts: ModelStrikeOptions = {}) {
    this.threshold = Math.max(1, opts.threshold ?? 10);
    this.windowMs = Math.max(1, opts.windowMs ?? 5 * 60_000);
    this._banTtlMs = Math.max(1, opts.banTtlMs ?? 60 * 60_000);
  }

  /** The ban threshold, for an operator-facing warning message. */
  get limit(): number {
    return this.threshold;
  }

  get banTtlMs(): number {
    return this._banTtlMs;
  }


  /** Read-only ban lookup for the pre-parse gate. Throws only on store outage. */
  async check(input: { readonly ip: string }): Promise<boolean> {
    return this.store.isBanned(input.ip);
  }

  /** Records one invalid-model attempt and returns the escalation decision. */
  async noteInvalid(input: { readonly ip: string }): Promise<ModelAbuseOutcome> {
    const outcome = await this.store.record({
      ip: input.ip,
      valid: false,
      threshold: this.threshold,
      windowMs: this.windowMs,
      banTtlMs: this.banTtlMs,
    });
    if (outcome.strikes > 0) this.dirty.add(input.ip);
    return outcome;
  }

  /**
   * Clears a strike after a valid-model request. Writes only when this process
   * saw a strike for the address, so the reset never costs a round trip on a
   * client that has nothing to clear.
   */
  async noteValid(input: { readonly ip: string }): Promise<void> {
    if (!this.dirty.delete(input.ip)) return;
    await this.store.record({
      ip: input.ip,
      valid: true,
      threshold: this.threshold,
      windowMs: this.windowMs,
      banTtlMs: this.banTtlMs,
    });
  }

  async listBans(): Promise<readonly ModelAbuseBan[]> {
    return this.store.listBans();
  }

  async unban(ip: string): Promise<boolean> {
    return this.store.unban(ip);
  }
}

/**
 * The typed rejection a banned caller receives. 403 with its own code so the
 * console and the client can tell an abuse ban from a per-request rejection.
 */
export function modelAbuseBannedError(): GatewayError {
  return new GatewayError(
    "model_abuse_banned",
    403,
    "This client address is banned for repeatedly requesting unavailable models",
  );
}

/**
 * The 404 a rejected model returns, carrying the escalating warning. The message
 * names the strike count so an honest client that mistyped is told exactly what
 * it is doing wrong before it is banned, instead of seeing the same generic 404
 * ten times and then a wall.
 */
export function modelWarningMessage(
  model: string,
  outcome: ModelAbuseOutcome,
  limit: number,
  banTtlMs?: number,
): string {
  const remaining = Math.max(0, limit - outcome.strikes);
  const banMinutes = banTtlMs ? Math.max(1, Math.ceil(banTtlMs / 60_000)) : undefined;
  const banClause = banMinutes ? ` for ~${banMinutes} min` : "";
  const tail =
    remaining === 0
      ? `The next invalid request will temporarily ban this IP${banClause}. Use /v1/models to see allowed models.`
      : remaining === 1
        ? `1 more invalid request will temporarily ban this IP${banClause}. Use /v1/models to see allowed models.`
        : `${remaining} more invalid requests will temporarily ban this IP${banClause}. Use /v1/models to see allowed models.`;
  return `Model '${model}' is not available to this API key. Warning ${outcome.strikes}/${limit} — ${tail}`;
}
