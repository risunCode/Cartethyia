import { describe } from "bun:test";
import { applySqlMigrations, getDb, getPool } from "../../src/persistence/postgres";
import {
  bundledModelCatalog,
  seedBundledProviders,
} from "../../src/providers/operations/provider-catalog-service";
import { seedBundledModels } from "../../src/providers/operations/provider-catalog-seeder";
import { createDefaultProviderRegistry } from "../../src/providers/default-registry";

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
 *
 * Routing is also not enough on its own: the suites read the schema and the
 * shipped provider catalog, so the database must already hold both. The
 * application establishes them at boot (`ensureMigrated` + the bundled seeders
 * in the dependency builder), which is why a long-lived developer database
 * always has them and nobody noticed the harness never did — until the gate
 * pointed at a database created a moment ago, where every DB suite failed on
 * `relation "tenants" does not exist` and the quota suites on a foreign key to
 * an unseeded provider. A database created a moment ago is exactly the
 * deployment case, so the gate performs the same two steps the application does
 * before any suite runs. Both are idempotent — the migration runner skips ids
 * already in its ledger under a cross-process advisory lock, and the seeders
 * upsert — so a warm database is reconciled rather than rebuilt, and parallel
 * test files converge instead of racing.
 */

const url = process.env.CARTETHYIA_TEST_DATABASE_URL?.trim();

if (!url) {
  console.info(
    "[db-gate] skipped: set CARTETHYIA_TEST_DATABASE_URL to an isolated PostgreSQL database to run DB integration checks",
  );
} else {
  process.env.DATABASE_URL = url;
  // Top-level await: this module is imported by every DB-gated suite, so the
  // schema and catalog land before any of them collects.
  await applySqlMigrations(getPool());
  const db = getDb();
  await seedBundledProviders(db);
  const catalog = await bundledModelCatalog(createDefaultProviderRegistry());
  await seedBundledModels(db, catalog.modelsByProvider);
}

/** The isolated test database URL, or `undefined` when DB suites are skipped. */
export const testDatabaseUrl = url;

/** `describe` that runs only when an isolated test database is configured. */
export const dbDescribe = url ? describe : describe.skip;
