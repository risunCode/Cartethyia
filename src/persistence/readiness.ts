// Boot readiness: cached probe over database connectivity, applied migrations, and Redis.
import { sql } from "drizzle-orm";
import { readMigrationLedgerStatus } from "./postgres";
import type { CartethyiaDatabase } from "./postgres";
import type { RedisClient } from "./redis";
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
  readonly redisMode: RedisMode;
  readonly timeoutMs: number;
}

let readinessMemo:
  | { key: ReadinessMemoKey; at: number; value: ReadinessCheckResult }
  | undefined;

function sameMemoKey(left: ReadinessMemoKey, right: ReadinessMemoKey): boolean {
  return (
    left.db === right.db &&
    left.redis === right.redis &&
    left.redisMode === right.redisMode &&
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
  readonly redis: "connected" | "disconnected" | "not_configured";
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
  redisMode: RedisMode,
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

  // 3. Check Redis (unless in single_instance_local mode)
  let redisOk = redisMode === "single_instance_local";

  if (redisMode === "normal" && redis) {
    try {
      const result = await withTimeoutCheck(() => redis.ping(), "Redis connectivity check");
      if (result !== "timeout" && result === "PONG") {
        redisOk = true;
      }
    } catch {
      // Redis check failed
    }
  }

  if (!redisOk && redisMode === "normal") {
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
    redis: redisMode === "single_instance_local" ? "not_configured" : "connected",
  };
}

/**
 * Checks if all required bootstrap dependencies are ready, memoizing the
 * result for {@link READINESS_MEMO_TTL_MS}. The memo is keyed on the full probe
 * identity — database instance, Redis client, Redis mode, and timeout — so
 * single-instance production shares one cache while tests that pass fresh mock
 * databases or a different mode/timeout never see a stale result.
 */
export async function checkReadiness(
  db: CartethyiaDatabase,
  redis: RedisClient | undefined,
  redisMode: RedisMode,
  timeoutMs: number = 5000,
): Promise<ReadinessCheckResult> {
  const key: ReadinessMemoKey = { db, redis, redisMode, timeoutMs };
  const now = Date.now();
  if (readinessMemo && sameMemoKey(readinessMemo.key, key) && now - readinessMemo.at < READINESS_MEMO_TTL_MS) {
    return readinessMemo.value;
  }
  const value = await runReadinessChecks(db, redis, redisMode, timeoutMs);
  readinessMemo = { key, at: Date.now(), value };
  return value;
}

/**
 * Redis coordination mode selector for {@link checkReadiness}.
 */

export type RedisMode = "normal" | "single_instance_local";

export function resolveRedisMode(env: NodeJS.ProcessEnv = process.env): RedisMode {
  const mode = env.REDIS_MODE ?? "normal";
  if (mode !== "normal" && mode !== "single_instance_local") {
    throw new Error(`REDIS_MODE must be normal or single_instance_local (got "${mode}")`);
  }
  return mode;
}
