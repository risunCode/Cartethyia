// Quota cache: two-tier (in-process TtlCache + Redis) store for provider quota reads.
//
// Entries are stored as a versioned envelope (`{ v: 2, fetchedAt, quota }`) so a
// cached value carries *when* it was fetched. The sweep worker needs that age to
// decide what is due, and the dashboard's "Last refreshed" is only honest if it
// comes from the cache rather than from an unrelated account timestamp.
//
// Cutover is two releases, not one: this release still *reads* the pre-envelope
// bare result (with `fetchedAt: null`) so an upgrade never blanks the page,
// while every *write* uses the envelope. Release N+1 — after one TTL window has
// drained the old entries — drops that read branch and the multi-lens scan in
// `invalidateQuotaCacheForAccount`. No third shape may be added.
import type { ProviderQuotaResult } from "../../providers/quota/quota-contracts";
import type { RedisClient } from "../../persistence/redis";
import { TtlCache } from "../../runtime/ttl-cache";
import { log } from "../../observability/logger";
import { metrics } from "../../observability/metrics";

const QUOTA_KEY_PREFIX = "quota:";
const QUOTA_TTL_SECONDS = 300;
const QUOTA_TTL_MS = QUOTA_TTL_SECONDS * 1000;

/**
 * Cache lens for tenant-null (global/shared) accounts. One entry serves every
 * tenant: a shared account's quota is the same fact whoever asks, so keying it
 * per tenant would mean N fetches for one answer and let the sweep warm only
 * the lens it happens to know.
 */
export const GLOBAL_QUOTA_LENS = "global";

interface CachedQuotaEnvelope {
  readonly v: 2;
  readonly fetchedAt: string;
  readonly quota: ProviderQuotaResult;
}

export interface CachedQuotaEntry {
  readonly quota: ProviderQuotaResult;
  /** ISO timestamp of the fetch, or `null` for a release-N bare entry without one. */
  readonly fetchedAt: string | null;
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

/** Parses a stored envelope, or a release-N bare result; anything else is a miss. */
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
    record["v"] === 2 &&
    typeof inner === "object" &&
    inner !== null &&
    !Array.isArray(inner)
  ) {
    return {
      quota: inner as ProviderQuotaResult,
      fetchedAt: typeof record["fetchedAt"] === "string" ? record["fetchedAt"] : null,
    };
  }
  // Release N only: the quota result was the whole value, so its age is unknown.
  return { quota: parsed as ProviderQuotaResult, fetchedAt: null };
}

export async function getCachedQuotaEntry(
  lens: string,
  accountId: string,
  redis: RedisClient,
): Promise<CachedQuotaEntry | null> {
  const key = quotaKey(lens, accountId);
  const inMem = inMemoryQuotaCache.get(key);
  if (inMem !== undefined) return inMem;

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

export async function getCachedQuota(
  lens: string,
  accountId: string,
  redis: RedisClient,
): Promise<ProviderQuotaResult | null> {
  return (await getCachedQuotaEntry(lens, accountId, redis))?.quota ?? null;
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
  redis: RedisClient,
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

  const mget = (redis as { mget?: unknown }).mget;
  if (typeof mget !== "function") {
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
  redis: RedisClient,
  fetchedAt: Date = new Date(),
): Promise<void> {
  const key = quotaKey(lens, accountId);
  const fetchedAtIso = fetchedAt.toISOString();
  inMemoryQuotaCache.set(key, { quota, fetchedAt: fetchedAtIso });
  try {
    const envelope: CachedQuotaEnvelope = { v: 2, fetchedAt: fetchedAtIso, quota };
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
  redis: RedisClient,
): Promise<void> {
  const key = quotaKey(lens, accountId);
  inMemoryQuotaCache.delete(key);
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
  redis: RedisClient,
): Promise<void> {
  const suffix = `:${accountId}`;
  for (const key of inMemoryQuotaCache.keys()) {
    if (key.endsWith(suffix)) inMemoryQuotaCache.delete(key);
  }
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
