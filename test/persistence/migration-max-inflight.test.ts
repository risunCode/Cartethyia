/**
 * The migration that retires `provider_accounts.max_inflight`.
 *
 * A schema migration is the one kind of change that cannot be verified by
 * reading code: the SQL either applies to a real database or it does not, and a
 * migration that silently no-ops leaves the column on every deployed instance
 * while a fresh install never creates it. Those two shapes then diverge, which
 * is precisely what the baseline-plus-forward-file convention exists to prevent.
 *
 * Isolation is the whole difficulty. The obvious approach — recreate the
 * column, delete the ledger row, call `applySqlMigrations`, assert — mutates
 * *shared* state that every other database suite depends on, and it races:
 * another suite's `getTestPool()` runs the same runner, sees the ledger row
 * missing, re-applies the file, and drops the column out from under this
 * assertion. Measured, that is exactly what happened the first time this file
 * ran under `--parallel` (4 pass alone, 1 fail in the suite).
 *
 * So the migration's own SQL is applied inside a transaction that is always
 * rolled back. PostgreSQL DDL is transactional, so the uncommitted
 * `DROP COLUMN` is invisible to every other connection and the ledger is never
 * touched, while the assertions still run against the real column of the real
 * table. The SQL is read from the tracked file rather than restated, so the
 * test cannot drift from what a deployment actually runs.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { dbDescribe, getTestPool, withRollback } from "../helpers/database";

const MIGRATION_FILE = "0029_retire_per_account_max_inflight.sql";

/** Every table that legitimately still carries a `max_inflight` column. */
const SURVIVING_TABLES = ["network_pools", "provider_routing_settings"];

/** The migration's SQL, read from the tracked file rather than restated. */
function migrationSql(): string {
  return readFileSync(resolve(process.cwd(), "migrations", MIGRATION_FILE), "utf8");
}

/** Column names on `provider_accounts` named `max_inflight`. */
async function accountInflightColumns(client: {
  query: (text: string) => Promise<{ rows: unknown[] }>;
}): Promise<number> {
  const result = await client.query(
    `select column_name from information_schema.columns
      where table_name = 'provider_accounts' and column_name = 'max_inflight'`,
  );
  return result.rows.length;
}

/** Recreates the pre-migration shape so the migration has real work to do. */
const REINSTATE_COLUMN =
  'ALTER TABLE "provider_accounts" ADD COLUMN IF NOT EXISTS "max_inflight" integer';

dbDescribe("migration: retire the per-account max_inflight", () => {
  test("drops the column from a database that still has it", async () => {
    await withRollback(async (client) => {
      await client.query(REINSTATE_COLUMN);
      expect(await accountInflightColumns(client)).toBe(1);

      await client.query(migrationSql());

      expect(await accountInflightColumns(client)).toBe(0);
    });
  });

  test("leaves the other concurrency ceilings in place", async () => {
    // The per-account column is dead, but concurrency is still capped — by the
    // provider-wide setting and the network-pool limit. A migration that took
    // out either of those would be deleting live policy.
    await withRollback(async (client) => {
      await client.query(REINSTATE_COLUMN);
      await client.query(migrationSql());

      const remaining = await client.query(
        `select table_name from information_schema.columns
          where column_name = 'max_inflight' order by table_name`,
      );
      expect(
        (remaining.rows as Array<{ table_name: string }>).map((row) => row.table_name),
      ).toEqual(SURVIVING_TABLES);
    });
  });

  test("is idempotent: applying it twice does not error", async () => {
    // `DROP COLUMN IF EXISTS` is what makes a partially-applied migration
    // recoverable, and a restart that re-runs an unrecorded file safe.
    await withRollback(async (client) => {
      await client.query(REINSTATE_COLUMN);
      await client.query(migrationSql());
      await client.query(migrationSql());

      expect(await accountInflightColumns(client)).toBe(0);
    });
  });

  test("the column is absent from the applied schema, and the file is recorded", async () => {
    // The committed end state a deployed database reaches once the runner has
    // recorded the file. Read outside a transaction so it reflects what other
    // suites see, and reads only — nothing here mutates shared state.
    const pool = await getTestPool();
    const client = await pool.connect();
    try {
      expect(await accountInflightColumns(client)).toBe(0);

      const recorded = await client.query(
        "select migration_id from cartethyia_schema_migrations where migration_id = $1",
        [MIGRATION_FILE],
      );
      expect(recorded.rows.length).toBe(1);
    } finally {
      client.release();
    }
  });
});
