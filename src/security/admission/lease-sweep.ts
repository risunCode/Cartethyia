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

export async function sweepLeases(redis: RedisClient): Promise<void> {
  let cursor = "0";
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      "MATCH",
      ADMISSION_LEASE_PATTERN,
      "COUNT",
      100,
    );
    cursor = nextCursor;
    for (const key of keys) await reapIfExpired(redis, key);
  } while (cursor !== "0");
}

async function reapIfExpired(redis: RedisClient, key: string): Promise<void> {
  try {
    const state = await redis.hget(key, "state");
    if (state !== "active") return;
    const expiresAt = Number(await redis.hget(key, "expires_at"));
    if (!Number.isFinite(expiresAt) || expiresAt >= Date.now()) return;
    await releaseAdmissionLease(redis, key);
  } catch (error) {
    log.error("[lease-sweep] failed to reap lease", error as Error, key);
  }
}
