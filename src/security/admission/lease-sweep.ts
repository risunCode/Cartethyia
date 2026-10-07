import type { RedisClient } from "../../persistence/redis";
import { log } from "../../observability/logger";
import { releaseAdmissionLease } from "./redis-store";

/**
 * Lease sweep: reaps crashed admission leases whose TTL has expired so
 * `admission:concurrent:*` and `admission:tenant_concurrent:*` do not leak
 * after a process dies before commit/release. Registered as a task on
 * `ScheduledTaskRegistry`, which owns the interval/re-entrancy/logging.
 */

const ADMISSION_LEASE_PATTERN = "admission:lease:*";

/**
 * Bounds for one pass.
 *
 * The scan walks the whole keyspace and the loop used to follow the cursor
 * until it wrapped, reaping every expired lease it found. On a keyspace that
 * has grown for months that is one pass with no ceiling: it holds the timer
 * slot for as long as the backlog takes and starves every other sweep. A
 * backlog drains over successive passes instead; leases the cap leaves behind
 * are still expired on the next tick.
 */
export const MAX_LEASE_SCAN_ITERATIONS = 50;
export const MAX_LEASE_REAPS_PER_PASS = 500;

export async function sweepLeases(redis: RedisClient): Promise<void> {
  let cursor = "0";
  let iterations = 0;
  let reaped = 0;
  do {
    if (iterations >= MAX_LEASE_SCAN_ITERATIONS || reaped >= MAX_LEASE_REAPS_PER_PASS) return;
    iterations += 1;
    const [nextCursor, keys] = await redis.scan(
      cursor,
      "MATCH",
      ADMISSION_LEASE_PATTERN,
      "COUNT",
      100,
    );
    cursor = nextCursor;
    for (const key of keys) {
      if (reaped >= MAX_LEASE_REAPS_PER_PASS) return;
      if (await reapIfExpired(redis, key)) reaped += 1;
    }
  } while (cursor !== "0");
}

/** Reaps one lease. Returns whether a lease was actually released. */
async function reapIfExpired(redis: RedisClient, key: string): Promise<boolean> {
  try {
    const state = await redis.hget(key, "state");
    if (state !== "active") return false;
    const expiresAt = Number(await redis.hget(key, "expires_at"));
    if (!Number.isFinite(expiresAt) || expiresAt >= Date.now()) return false;
    await releaseAdmissionLease(redis, key);
    return true;
  } catch (error) {
    log.error("[lease-sweep] failed to reap lease", error as Error, key);
    return false;
  }
}
