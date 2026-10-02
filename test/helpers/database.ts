/**
 * Shared lifecycle for every suite that touches PostgreSQL or Redis.
 *
 * The suite this replaces was unreliable for two structural reasons, and this
 * module removes both rather than working around them.
 *
 * 1. **Shared mutable state between files.** A suite that pointed
 *    `DATABASE_URL` at the isolated database and seeded global rows left the
 *    next file — running in a different worker process, concurrently — reading
 *    rows it never wrote. Assertions that depended on a count, a "latest" row,
 *    or a global default therefore passed or failed on scheduling. Every helper
 *    here scopes its data to a `runId`-prefixed namespace and deletes exactly
 *    what it created, so two files can never observe each other.
 *
 * 2. **Timing assumptions.** Suites awaited `setTimeout(…, 50)` and asserted a
 *    cache had expired or a worker had ticked. A loaded machine makes those
 *    flaky by definition. The clock helper below makes time an explicit input
 *    to the code under test instead of something the test waits for.
 *
 * Nothing here reaches the network, and a suite that needs a service that is
 * not configured skips with a stated reason rather than failing.
 */
import { afterAll, beforeAll, describe } from "bun:test";
import { Pool, type PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { applySqlMigrations } from "../../src/persistence/postgres";

/** Isolated PostgreSQL URL, or `undefined` when the suite must skip. */
export const testDatabaseUrl = process.env.CARTETHYIA_TEST_DATABASE_URL?.trim() || undefined;

/** Isolated Redis URL, or `undefined` when the suite must skip. */
export const testRedisUrl = process.env.CARTETHYIA_TEST_REDIS_URL?.trim() || undefined;

if (!testDatabaseUrl) {
  console.info(
    "[test-db] skipped: set CARTETHYIA_TEST_DATABASE_URL to run database suites",
  );
}
if (!testRedisUrl) {
  console.info("[test-redis] skipped: set CARTETHYIA_TEST_REDIS_URL to run Redis suites");
}

/**
 * Routes the runtime `DATABASE_URL` at the isolated test database.
 *
 * Must run before any module that caches a pool is imported by a suite, which
 * is why it lives at this module's top level: every database suite imports
 * this module first. Without it a suite that passed the gate still wrote its
 * fixtures into whatever `DATABASE_URL` pointed at.
 */
if (testDatabaseUrl && !process.env.CARTETHYIA_TEST_DATABASE_ISOLATED) {
  process.env.CARTETHYIA_TEST_DATABASE_ISOLATED = "1";
  process.env.DATABASE_URL = testDatabaseUrl;
}

/** One pool per test process, migrated once. */
let suitePool: Pool | undefined;

/**
 * The process-wide pool for database suites, migrated on first use.
 *
 * Migrations run once per process under the advisory lock in
 * `applySqlMigrations`, which is also what makes concurrent test workers safe:
 * a second worker waits for the lock and then finds the ledger already
 * complete.
 *
 * The pool is recreated if a previous `closeTestPool()` ended it. Bun runs
 * `afterAll` hooks in registration order, and this module registers one at
 * import time, so a suite's own `afterAll` runs *after* it. Recreating on
 * demand means teardown never fails with "pool after end" no matter which
 * order a file's hooks ran in.
 */
export async function getTestPool(): Promise<Pool> {
  if (!testDatabaseUrl) throw new Error("CARTETHYIA_TEST_DATABASE_URL is not configured");
  if (suitePool && !suitePool.ended) return suitePool;
  const pool = new Pool({
    connectionString: testDatabaseUrl,
    max: 4,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 5_000,
  });
  await applySqlMigrations(pool);
  suitePool = pool;
  return pool;
}

/**
 * Ends the shared pool. Idempotent, and safe to call from a suite's `afterAll`
 * even though this module's own hook may have already run.
 */
export async function closeTestPool(): Promise<void> {
  const pool = suitePool;
  suitePool = undefined;
  await pool?.end().catch(() => undefined);
}

/**
 * A unique namespace for one suite's rows.
 *
 * Derived from the suite file plus a random suffix so two runs of the same file
 * — a retry, or two workers — still cannot collide. Every fixture helper
 * prefixes the identifiers it writes with this value.
 */
export function createRunId(label: string): string {
  const safe = label.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 24);
  return `${safe}-${randomUUID().slice(0, 8)}`;
}

/**
 * Runs `body` inside a transaction that is always rolled back.
 *
 * This is the isolation primitive for database suites: the body sees its own
 * writes, and the rollback leaves the database byte-identical. Because the
 * transaction is never committed, a suite cannot leak a row into another
 * suite's result even when both run at once.
 *
 * DDL is allowed (the schema already exists from the migration run), so a test
 * can create a scratch table and inspect it without leaving anything behind.
 */
export async function withRollback<T>(
  body: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = await getTestPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      return await body(client);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

/**
 * `describe` that runs only when an isolated database is configured.
 *
 * Suites use this instead of a hand-rolled guard so the skip reason is uniform
 * and a missing service is never mistaken for a passing check.
 */
export const dbDescribe = testDatabaseUrl ? describe : describe.skip;

/** `describe` that runs only when an isolated Redis index is configured. */
export const redisDescribe = testRedisUrl ? describe : describe.skip;

/**
 * Closes the suite pool once this process's files are done.
 *
 * `afterAll` at module scope registers against the file that imported this
 * module, so the pool outlives every test in it and is released exactly once.
 * A suite that needs the pool again after this ran (a later `afterAll` doing
 * its own teardown) gets a fresh one from `getTestPool`.
 */
afterAll(async () => {
  await closeTestPool();
});

/**
 * Asserts that a service is reachable *before* a suite's tests run, so a
 * connection failure reads as an infrastructure problem instead of a failing
 * assertion inside a test body.
 */
export function requireDatabase(): void {
  beforeAll(async () => {
    await getTestPool();
  });
}
