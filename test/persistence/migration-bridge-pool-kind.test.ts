/**
 * The migration that adds the `bridge` network-pool kind.
 *
 * `network_pool_kind` is a PostgreSQL enum, and an enum's labels are part of the
 * schema a database already has: adding one is a real DDL change that a deployed
 * database needs, not a comment. A baseline edit alone would leave every existing
 * install without the label while a fresh install has it — the two shapes diverge,
 * which is exactly what the baseline-plus-forward-file convention exists to
 * prevent. So this pins that the forward file actually extends the type, that it
 * is retry-safe, and that it leaves the existing labels alone.
 *
 * The migration's own SQL is applied inside a transaction that is always rolled
 * back (PostgreSQL DDL is transactional), so the uncommitted enum change is
 * invisible to every other connection and the migration ledger is never touched.
 * The SQL is read from the tracked file rather than restated, so the test cannot
 * drift from what a deployment runs.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { dbDescribe, getTestPool, withRollback } from "../helpers/database";

const MIGRATION_FILE = "0030_add_bridge_pool_kind.sql";

/** The migration's SQL, read from the tracked file rather than restated. */
function migrationSql(): string {
  return readFileSync(resolve(process.cwd(), "migrations", MIGRATION_FILE), "utf8");
}

/** Every label currently on the `network_pool_kind` enum, in definition order. */
async function poolKindLabels(client: {
  query: (text: string) => Promise<{ rows: unknown[] }>;
}): Promise<string[]> {
  const result = await client.query(
    `select e.enumlabel
       from pg_enum e
       join pg_type t on t.oid = e.enumtypid
      where t.typname = 'network_pool_kind'
      order by e.enumsortorder`,
  );
  return (result.rows as Array<{ enumlabel: string }>).map((row) => row.enumlabel);
}

/**
 * Reverts the type to its pre-migration shape so the migration has real work to
 * do. An enum cannot drop a label in place, so the type is rebuilt exactly as a
 * database that predates this migration would have it.
 */
const REINSTATE_ENUM = `
  ALTER TYPE "public"."network_pool_kind" RENAME TO "network_pool_kind_old";
  CREATE TYPE "public"."network_pool_kind" AS ENUM('http', 'socks5');
  ALTER TABLE "public"."network_pools"
    ALTER COLUMN "kind" TYPE "public"."network_pool_kind"
      USING "kind"::text::"public"."network_pool_kind";
  DROP TYPE "public"."network_pool_kind_old";
`;

dbDescribe("migration: add the bridge network-pool kind", () => {
  test("adds the label to a database that lacks it", async () => {
    await withRollback(async (client) => {
      await client.query(REINSTATE_ENUM);
      expect(await poolKindLabels(client)).toEqual(["http", "socks5"]);

      await client.query(migrationSql());

      expect(await poolKindLabels(client)).toEqual(["http", "socks5", "bridge"]);
    });
  });

  test("keeps the existing labels usable", async () => {
    // Adding `bridge` must not disturb a stored `http`/`socks5` row: the label
    // is additive, and a migration that rebuilt the type without carrying the
    // old labels would fail to cast existing rows and abort the whole startup.
    await withRollback(async (client) => {
      await client.query(REINSTATE_ENUM);
      // `network_pools.tenant_id` is a real foreign key, so the row needs a
      // tenant to point at. Both writes are rolled back with the transaction.
      const tenantId = crypto.randomUUID();
      await client.query(
        `insert into tenants (id, name, status) values ($1, $2, 'active')`,
        [tenantId, "bridge-migration-test"],
      );
      await client.query(
        `insert into network_pools
           (id, tenant_id, kind, endpoint_config, status, consecutive_failures, weight, max_inflight, created_at)
         values ($1, $2, 'socks5', $3::jsonb, 'active', 0, 100, 10, now())`,
        [crypto.randomUUID(), tenantId, JSON.stringify({ endpoint: "socks5://127.0.0.1:1080" })],
      );

      await client.query(migrationSql());

      expect(await poolKindLabels(client)).toEqual(["http", "socks5", "bridge"]);
      const kinds = await client.query(
        `select distinct "kind"::text as kind from "public"."network_pools"`,
      );
      expect((kinds.rows as Array<{ kind: string }>).every((row) => row.kind === "socks5")).toBe(true);
    });
  });

  test("is idempotent: applying it twice does not error", async () => {
    // `ADD VALUE IF NOT EXISTS` is what makes a restart that re-runs an
    // unrecorded file safe, and a fresh install that already has the label
    // (from the updated baseline) a no-op.
    await withRollback(async (client) => {
      await client.query(REINSTATE_ENUM);
      await client.query(migrationSql());
      await client.query(migrationSql());

      expect(await poolKindLabels(client)).toEqual(["http", "socks5", "bridge"]);
    });
  });

  test("the applied schema carries the label and the file is recorded", async () => {
    // The committed end state a deployed database reaches once the runner has
    // recorded the file. Read outside a transaction so it reflects what other
    // suites see, and reads only — nothing here mutates shared state.
    const pool = await getTestPool();
    const client = await pool.connect();
    try {
      expect(await poolKindLabels(client)).toEqual(["http", "socks5", "bridge"]);

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
