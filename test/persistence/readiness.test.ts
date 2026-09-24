import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { checkReadiness, type ReadinessCheckResult } from "../../src/persistence/readiness";
import type { CartethyiaDatabase } from "../../src/persistence/postgres";
import type { RedisClient } from "../../src/persistence/redis";

/** Migration ids discovered on disk — the ledger must contain every one of them. */
const expectedMigrationIds = readdirSync(
  resolve(import.meta.dir, "../../drizzle/migrations"),
).filter((file) => /^\d{4}_.+\.sql$/.test(file));

/** Drizzle-shaped `execute` result; the readiness ledger query reads `.rows`. */
const ledgerResult = (migrationIds: readonly string[]) => ({
  rows: migrationIds.map((migration_id) => ({ migration_id })),
});

/** Mock database whose migration ledger records every migration on disk. */
const mockDbSuccess = (): CartethyiaDatabase =>
  ({
    execute: async () => ledgerResult(expectedMigrationIds),
  }) as unknown as CartethyiaDatabase;

/** Mock database that fails */
const mockDbFailure = (): CartethyiaDatabase =>
  ({
    execute: async () => {
      throw new Error("Database connection failed");
    },
  }) as unknown as CartethyiaDatabase;

/** Mock database where the migration ledger table doesn't exist */
const mockDbNoPendingMigrations = (): CartethyiaDatabase => {
  let callCount = 0;
  return {
    execute: async () => {
      callCount++;
      if (callCount === 1) {
        // First call is "SELECT 1" - succeeds
        return [{ value: 1 }];
      }
      throw new Error('relation "cartethyia_schema_migrations" does not exist');
    },
  } as unknown as CartethyiaDatabase;
};

/** Mock database whose ledger is missing the last discovered migration. */
const mockDbPartiallyApplied = (): CartethyiaDatabase =>
  ({
    execute: async () => ledgerResult(expectedMigrationIds.slice(0, -1)),
  }) as unknown as CartethyiaDatabase;

/** Mock Redis that succeeds */
const mockRedisSuccess = (): RedisClient =>
  ({
    ping: async () => "PONG",
  }) as unknown as RedisClient;

/** Mock Redis that fails */
const mockRedisFailure = (): RedisClient =>
  ({
    ping: async () => {
      throw new Error("Redis connection failed");
    },
  }) as unknown as RedisClient;

test("checkReadiness - all dependencies ready", async () => {
  const result = await checkReadiness(mockDbSuccess(), mockRedisSuccess(), "normal", 5000);

  expect(result).toEqual<ReadinessCheckResult>({
    status: "ready",
    db: "connected",
    migrations: "applied",
    redis: "connected",
  });
});

test("checkReadiness - database disconnected", async () => {
  const result = await checkReadiness(mockDbFailure(), mockRedisSuccess(), "normal", 5000);

  expect(result).toEqual<ReadinessCheckResult>({
    status: "not_ready",
    db: "disconnected",
    migrations: "pending",
    redis: "disconnected",
    reason: "database not connected",
  });
});

test("checkReadiness - migrations not yet applied", async () => {
  const result = await checkReadiness(
    mockDbNoPendingMigrations(),
    mockRedisSuccess(),
    "normal",
    5000,
  );

  expect(result).toEqual<ReadinessCheckResult>({
    status: "not_ready",
    db: "connected",
    migrations: "pending",
    redis: "disconnected",
    reason: "migrations not yet applied",
  });
});

test("checkReadiness - an interrupted upgrade with a partially applied ledger is not ready", async () => {
  const result = await checkReadiness(
    mockDbPartiallyApplied(),
    mockRedisSuccess(),
    "normal",
    5000,
  );

  expect(result.status).toBe("not_ready");
  expect(result.db).toBe("connected");
  expect(result.migrations).toBe("pending");
  expect(result.reason).toBe("migrations not yet applied");
});

test("checkReadiness - redis disconnected in normal mode", async () => {
  const result = await checkReadiness(mockDbSuccess(), mockRedisFailure(), "normal", 5000);

  expect(result).toEqual<ReadinessCheckResult>({
    status: "not_ready",
    db: "connected",
    migrations: "applied",
    redis: "disconnected",
    reason: "redis not connected",
  });
});

test("checkReadiness - single_instance_local mode skips redis check", async () => {
  const result = await checkReadiness(
    mockDbSuccess(),
    undefined, // No Redis in local mode
    "single_instance_local",
    5000,
  );

  expect(result).toEqual<ReadinessCheckResult>({
    status: "ready",
    db: "connected",
    migrations: "applied",
    redis: "not_configured", // Redis is not used in single_instance_local
  });
});

test("checkReadiness - no fallback when dependency fails before ready", async () => {
  // Even if database is partially responsive, if migrations aren't applied,
  // should return not_ready
  const result = await checkReadiness(
    mockDbNoPendingMigrations(),
    mockRedisSuccess(),
    "normal",
    5000,
  );

  expect(result.status).toBe("not_ready");
  expect(result.db).toBe("connected");
  expect(result.migrations).toBe("pending");
});

test("checkReadiness - memo does not conflate probes that differ by timeout", async () => {
  let probes = 0;
  const db = {
    execute: async () => {
      probes += 1;
      return ledgerResult(expectedMigrationIds);
    },
  } as unknown as CartethyiaDatabase;
  const redis = mockRedisSuccess();

  await checkReadiness(db, redis, "normal", 5000);
  const afterFirst = probes;
  await checkReadiness(db, redis, "normal", 5000);
  expect(probes).toBe(afterFirst); // same probe identity -> memoized

  await checkReadiness(db, redis, "normal", 1000);
  expect(probes).toBeGreaterThan(afterFirst); // different timeout -> re-probed
});
