// Boot readiness: cached probe over database connectivity, applied migrations, and Redis.
import { sql } from "drizzle-orm";
import { readMigrationLedgerStatus } from "./postgres";
import type { CartethyiaDatabase } from "./postgres";
import type { RedisBackend, RedisClient } from "./redis";
import { withTimeout } from "../runtime/timeout";

// ===== readiness memo =====
/**
 * Memoized readiness: the first caller runs the real `SELECT 1`/`PING`/
 * migration checks, and every subsequent caller within the TTL window reuses
 * that result — so a burst of concurrent requests no longer each spend a
 * Postgres pool checkout plus a Redis PING on readiness validation.
 */

const READINESS_MEMO_TTL_MS = 5_000;

interface ReadinessMemoKey {
  readonly db: CartethyiaDatabase;
  readonly redis: RedisClient | undefined;
  readonly redisBackend: RedisBackend;
  readonly timeoutMs: number;
}

let readinessMemo:
  | { key: ReadinessMemoKey; at: number; value: ReadinessCheckResult }
  | undefined;
/** Shared in-flight promise so concurrent callers after TTL expiry share one probe. */
let readinessInflight: Promise<ReadinessCheckResult> | undefined;
let readinessInflightKey: ReadinessMemoKey | undefined;

function sameMemoKey(left: ReadinessMemoKey, right: ReadinessMemoKey): boolean {
  return (
    left.db === right.db &&
    left.redis === right.redis &&
    left.redisBackend === right.redisBackend &&
    left.timeoutMs === right.timeoutMs
  );
}

/**
 * Readiness coordinator checking database connectivity, migrations, and Redis.
 * Bootstrap prerequisites for /health/ready endpoint.
 * Checks DB, migrations, and Redis mode with bounded timeout.
 * Returns typed ready/not_ready response.
 */

export type ReadinessStatus = "ready" | "not_ready";

export interface ReadinessCheckResult {
  readonly status: ReadinessStatus;
  readonly db: "connected" | "disconnected";
  readonly migrations: "applied" | "pending";
  readonly redis: "connected" | "disconnected";
  readonly reason?: string;
}

/**
 * Runs the full dependency readiness check (see {@link checkReadiness}).
 * Uncached: kept private so the memoization in `checkReadiness` is the only
 * caching boundary and tests can reason about one entry point.
 */
async function runReadinessChecks(
  db: CartethyiaDatabase,
  redis: RedisClient | undefined,
  redisBackend: RedisBackend,
  timeoutMs: number = 5000,
): Promise<ReadinessCheckResult> {
  const startTime = Date.now();

  // Helper to enforce timeout on an async check
  const withTimeoutCheck = async <T>(check: () => Promise<T>, label: string): Promise<T | "timeout"> => {
    const elapsed = Date.now() - startTime;
    const remaining = Math.max(0, timeoutMs - elapsed);

    if (remaining <= 0) {
      return "timeout";
    }

    try {
      return await withTimeout(check(), remaining, `${label} timeout after ${remaining}ms`);
    } catch (error) {
      if (error instanceof Error && error.message.includes("timeout")) {
        return "timeout";
      }
      throw new Error(`${label} failed: ${String(error)}`);
    }
  };

  // 1. Check database connectivity via simple query
  let dbOk = false;
  try {
    const result = await withTimeoutCheck(
      () => db.execute(sql`SELECT 1`),
      "Database connectivity check",
    );
    if (result !== "timeout") {
      dbOk = true;
    }
  } catch {
    // Database check failed
  }

  if (!dbOk) {
    return {
      status: "not_ready",
      db: "disconnected",
      migrations: "pending",
      redis: "disconnected",
      reason: "database not connected",
    };
  }

  // SQL-only migration runner records applied files in the application ledger.
  // Readiness requires every discovered migration to have a ledger row; a
  // reachable ledger alone is not proof the upgrade finished.
  let migrationsApplied = false;
  try {
    const result = await withTimeoutCheck(
      () => readMigrationLedgerStatus(db),
      "Migrations check",
    );

    if (result !== "timeout") {
      migrationsApplied = result.applied;
    }
  } catch {
    // Migrations table doesn't exist or query failed
  }

  if (!migrationsApplied) {
    return {
      status: "not_ready",
      db: "connected",
      migrations: "pending",
      redis: "disconnected",
      reason: "migrations not yet applied",
    };
  }

  // 3. Check Redis. The memory backend is healthy by construction — there is
  // no connection to probe — so it passes without a round trip.
  let redisOk = redisBackend === "memory";

  if (redisBackend === "redis" && redis) {
    try {
      const result = await withTimeoutCheck(() => redis.ping(), "Redis connectivity check");
      if (result !== "timeout" && result === "PONG") {
        redisOk = true;
      }
    } catch {
      // Redis check failed
    }
  }

  if (!redisOk) {
    return {
      status: "not_ready",
      db: "connected",
      migrations: "applied",
      redis: "disconnected",
      reason: "redis not connected",
    };
  }

  // All checks passed
  return {
    status: "ready",
    db: "connected",
    migrations: "applied",
    redis: "connected",
  };
}

/**
 * Checks if all required bootstrap dependencies are ready, memoizing the
 * result for {@link READINESS_MEMO_TTL_MS}. The memo is keyed on the full probe
 * identity — database instance, Redis client, Redis backend, and timeout — so
 * single-instance production shares one cache while tests that pass fresh mock
 * databases or a different backend/timeout never see a stale result.
 */
export async function checkReadiness(
  db: CartethyiaDatabase,
  redis: RedisClient | undefined,
  redisBackend: RedisBackend,
  timeoutMs: number = 5000,
): Promise<ReadinessCheckResult> {
  const key: ReadinessMemoKey = { db, redis, redisBackend, timeoutMs };
  const now = Date.now();
  if (readinessMemo && sameMemoKey(readinessMemo.key, key) && now - readinessMemo.at < READINESS_MEMO_TTL_MS) {
    return readinessMemo.value;
  }
  // Single-flight: concurrent callers after TTL expiry share one probe instead
  // of N parallel Postgres/Redis round-trips.
  if (readinessInflight && readinessInflightKey && sameMemoKey(readinessInflightKey, key)) {
    return readinessInflight;
  }
  readinessInflightKey = key;
  readinessInflight = runReadinessChecks(db, redis, redisBackend, timeoutMs)
    .then((value) => {
      readinessMemo = { key, at: Date.now(), value };
      return value;
    })
    .finally(() => {
      readinessInflight = undefined;
      readinessInflightKey = undefined;
    });
  return readinessInflight;
}
