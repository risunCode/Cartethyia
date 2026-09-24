import { describe } from "bun:test";

/**
 * Single-source gate and connection router for DB-dependent integration suites.
 *
 * Every suite that needs a real, isolated PostgreSQL instance reads the same
 * `CARTETHYIA_TEST_DATABASE_URL` here and skips with the same reason, so the
 * isolation boundary never drifts between suites: a DB-gated `describe` block
 * collects its tests only when the URL is present, before any `Pool` is used.
 *
 * Gating alone is not isolation. `getDb()` / `getPool()` resolve `DATABASE_URL`,
 * so a suite that passed the gate still connected to whatever that pointed at —
 * a developer's working database — and left its fixtures there. The gate
 * therefore also *routes*: when the isolated URL is configured it becomes the
 * `DATABASE_URL` the rest of the process resolves. Pools are created lazily, so
 * this assignment lands before any connection exists.
 */

const url = process.env.CARTETHYIA_TEST_DATABASE_URL?.trim();

if (!url) {
  console.info(
    "[db-gate] skipped: set CARTETHYIA_TEST_DATABASE_URL to an isolated PostgreSQL database to run DB integration checks",
  );
} else {
  process.env.DATABASE_URL = url;
}

/** The isolated test database URL, or `undefined` when DB suites are skipped. */
export const testDatabaseUrl = url;

/** `describe` that runs only when an isolated test database is configured. */
export const dbDescribe = url ? describe : describe.skip;
