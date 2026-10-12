// Quota cache: two-tier (in-process TtlCache + Redis) store for provider quota reads.
//
// Entries are stored as a versioned envelope so cache retention, last attempt,
// and last successful reading can be tracked independently.
//
// Reads the pre-envelope bare result and v2-v4 envelopes during upgrade;
// writes use v5, which records attempt time, retained-refresh errors, and
// forces a one-time refresh for required quota accounting metadata.
import type { ProviderQuotaResult } from "../../providers/quota/quota-contracts";
import type { RedisClient } from "../../persistence/redis";
import { TtlCache } from "../../persistence/ttl-cache";
import { log } from "../../observability/logger";
import { metrics } from "../../observability/metrics";

const QUOTA_KEY_PREFIX = "quota:v5:";
const QUOTA_TTL_SECONDS = 900;
const QUOTA_TTL_MS = QUOTA_TTL_SECONDS * 1000;
const MAX_STALE_QUOTA_AGE_MS = 30 * 60_000;

/**
 * Cache lens for tenant-null (global/shared) accounts. One entry serves every
 * tenant: a shared account's quota is the same fact whoever asks, so keying it
 * per tenant would mean N fetches for one answer and let the sweep warm only
 * the lens it happens to know.
 */
export const GLOBAL_QUOTA_LENS = "global";

interface CachedQuotaEnvelope {
  readonly v: 5;
  readonly fetchedAt: string | null;
  readonly lastAttemptAt: string;
  readonly refreshError: string | null;
  readonly quota: ProviderQuotaResult;
}

export interface CachedQuotaEntry {
  readonly quota: ProviderQuotaResult;
  /** ISO timestamp of the most recent successful fetch. */
  readonly fetchedAt: string | null;
  /** ISO timestamp of the most recent fetch attempt. */
  readonly lastAttemptAt: string | null;
  /** Most recent refresh failure while retaining an older successful reading. */
  readonly refreshError: string | null;
}

const inMemoryQuotaCache = new TtlCache<CachedQuotaEntry>({
  ttlMs: QUOTA_TTL_MS,
  maxEntries: 1024,
});

/** Resolves the cache lens for an account: its owning tenant, or the shared lens. */
export function quotaLens(tenantId: string | null | undefined): string {
  return tenantId ?? GLOBAL_QUOTA_LENS;
}

function quotaKey(lens: string, accountId: string): string {
  return `${QUOTA_KEY_PREFIX}${lens}:${accountId}`;
}

/** Parses a versioned envelope or a release-N bare result. */
function parseCached(raw: string | null | undefined): CachedQuotaEntry | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const inner = record["quota"];
  if (
    (record["v"] === 2 ||
      record["v"] === 3 ||
      record["v"] === 4 ||
      record["v"] === 5) &&
    typeof inner === "object" &&
    inner !== null &&
    !Array.isArray(inner)
  ) {
    const fetchedAt = typeof record["fetchedAt"] === "string" ? record["fetchedAt"] : null;
    return {
      quota: inner as ProviderQuotaResult,
      fetchedAt,
      lastAttemptAt:
        typeof record["lastAttemptAt"] === "string"
          ? record["lastAttemptAt"]
          : fetchedAt,
      refreshError:
        (record["v"] === 3 || record["v"] === 4 || record["v"] === 5) &&
        typeof record["refreshError"] === "string"
          ? record["refreshError"]
          : null,
    };
  }
  // Release N only: the quota result was the whole value, so its age is unknown.
  if (
    typeof record["source"] !== "string" ||
    (record["plan"] !== null && typeof record["plan"] !== "string") ||
    !Array.isArray(record["windows"]) ||
    (record["error"] !== null && typeof record["error"] !== "string")
  ) {
    return null;
  }
  return { quota: parsed as ProviderQuotaResult, fetchedAt: null, lastAttemptAt: null, refreshError: null };
}

/**
 * Returns age since the most recent refresh attempt. Invalid or missing
 * timestamps are due immediately.
 */
export function cachedQuotaAgeMs(entry: CachedQuotaEntry | null | undefined, now = Date.now()): number {
  const timestamp = entry?.lastAttemptAt ?? entry?.fetchedAt;
  if (timestamp === null || timestamp === undefined) return Number.POSITIVE_INFINITY;
  const at = new Date(timestamp).getTime();
  return Number.isFinite(at) ? now - at : Number.POSITIVE_INFINITY;
}

export async function getCachedQuotaEntry(
  lens: string,
  accountId: string,
  redis: RedisClient | undefined,
): Promise<CachedQuotaEntry | null> {
  const key = quotaKey(lens, accountId);
  const inMem = inMemoryQuotaCache.get(key);
  if (inMem !== undefined) return inMem;
  // Memory backend: the in-process tier above is the whole cache.
  if (redis === undefined) return null;

  let raw: string | null = null;
  try {
    raw = await redis.get(key);
  } catch (error) {
    log.warn("quota cache read failed", { key, error: String(error) });
    return null;
  }
  const entry = parseCached(raw);
  if (entry) inMemoryQuotaCache.set(key, entry);
  return entry;
}

/**
 * Batch read for one lens: the memory tier answers what it can, then the
 * remaining keys go to Redis in a single `MGET`. The overview renders every
 * account at once, so one round trip per account would make the page's
 * latency scale with the account count.
 */
export async function getCachedQuotaEntries(
  lens: string,
  accountIds: readonly string[],
  redis: RedisClient | undefined,
): Promise<Map<string, CachedQuotaEntry>> {
  const found = new Map<string, CachedQuotaEntry>();
  const missing: string[] = [];
  for (const accountId of accountIds) {
    const key = quotaKey(lens, accountId);
    const hit = inMemoryQuotaCache.get(key);
    if (hit !== undefined) found.set(accountId, hit);
    else missing.push(accountId);
  }
  if (missing.length === 0) return found;
  // Memory backend (or a client without MGET): per-key reads, which hit the
  // in-process tier first and return null beyond it.
  if (redis === undefined || typeof redis.mget !== "function") {
    for (const accountId of missing) {
      const entry = await getCachedQuotaEntry(lens, accountId, redis);
      if (entry) found.set(accountId, entry);
    }
    return found;
  }

  try {
    const raws = (await redis.mget(...missing.map((accountId) => quotaKey(lens, accountId)))) as Array<
      string | null
    >;
    missing.forEach((accountId, index) => {
      const entry = parseCached(raws[index] ?? null);
      if (!entry) return;
      inMemoryQuotaCache.set(quotaKey(lens, accountId), entry);
      found.set(accountId, entry);
    });
  } catch (error) {
    // Redis outage: the memory tier already answered everything it could.
    log.warn("quota cache batch read failed", { lens, error: String(error) });
  }
  return found;
}

export async function setCachedQuota(
  lens: string,
  accountId: string,
  quota: ProviderQuotaResult,
  redis: RedisClient | undefined,
  fetchedAt: Date = new Date(),
): Promise<void> {
  const key = quotaKey(lens, accountId);
  const previous = await getCachedQuotaEntry(lens, accountId, redis);
  const attemptedAt = fetchedAt.toISOString();
  const previousSuccessAt =
    previous?.fetchedAt === null || previous?.fetchedAt === undefined
      ? null
      : new Date(previous.fetchedAt).getTime();
  const retainedSuccess =
    quota.error !== null &&
    previous?.quota.error === null &&
    previousSuccessAt !== null &&
    Number.isFinite(previousSuccessAt) &&
    fetchedAt.getTime() - previousSuccessAt <= MAX_STALE_QUOTA_AGE_MS;
  const entry: CachedQuotaEntry = retainedSuccess
    ? {
        quota: previous.quota,
        fetchedAt: previous.fetchedAt,
        lastAttemptAt: attemptedAt,
        refreshError: quota.error,
      }
    : {
        quota,
        fetchedAt: quota.error === null ? attemptedAt : null,
        lastAttemptAt: attemptedAt,
        refreshError: null,
      };
  inMemoryQuotaCache.set(key, entry);
  if (redis === undefined) return;
  try {
    const envelope: CachedQuotaEnvelope = {
      v: 5,
      fetchedAt: entry.fetchedAt,
      lastAttemptAt: attemptedAt,
      refreshError: entry.refreshError,
      quota: entry.quota,
    };
    await redis.set(key, JSON.stringify(envelope), "EX", QUOTA_TTL_SECONDS);
  } catch (error) {
    // In-memory cache holds the record if Redis is unavailable.
    log.warn("quota cache write failed", { key, error: String(error) });
  }
}

/** Drops one account from one lens (credential rotation, status change, delete). */
export async function invalidateQuotaCache(
  lens: string,
  accountId: string,
  redis: RedisClient | undefined,
): Promise<void> {
  const key = quotaKey(lens, accountId);
  inMemoryQuotaCache.delete(key);
  if (redis === undefined) return;
  try {
    await redis.del(key);
  } catch (error) {
    metrics.quota_cache_invalidate_failed.inc(1);
    log.warn("quota cache invalidate failed", { key, error: String(error) });
  }
}

/**
 * Drops one account from EVERY cache lens. Global accounts are shared, but a
 * release-N writer may have written the same account under a per-tenant lens,
 * so a global mutation clears all of them rather than assuming which lens this
 * instance last wrote. Release N+1 collapses this to a single `del` once every
 * writer goes through `quotaLens()` and no per-tenant copy can exist.
 */
export async function invalidateQuotaCacheForAccount(
  accountId: string,
  redis: RedisClient | undefined,
): Promise<void> {
  const suffix = `:${accountId}`;
  for (const key of inMemoryQuotaCache.keys()) {
    if (key.endsWith(suffix)) inMemoryQuotaCache.delete(key);
  }
  if (redis === undefined) return;
  try {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", `${QUOTA_KEY_PREFIX}*${suffix}`, "COUNT", 500);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== "0");
  } catch (error) {
    metrics.quota_cache_invalidate_failed.inc(1);
    log.warn("quota cache invalidate-all failed", { accountId, error: String(error) });
  }
}

/** Tracked keys in the in-process tier, for the runtime-metrics gauge. */
export function quotaCacheSize(): number {
  return inMemoryQuotaCache.size;
}

/** Test seam: the in-process tier is process-wide and must not leak across suites. */
export function clearQuotaCacheForTests(): void {
  inMemoryQuotaCache.clear();
}
