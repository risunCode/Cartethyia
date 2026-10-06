/**
 * Upgrade path for the fusion and minimum-balance removal.
 *
 * A database that stopped before `0032` still has the per-account floor and the
 * provider `credit_floor`. One that stopped after `0038` has the global credit
 * limit and fusion combos. Both must reach the current shape: no floor columns,
 * and combo strategies limited to `fallback` and `round_robin`. Fusion rows
 * become fallback so the combo itself is not deleted.
 *
 * The SQL is read from the tracked files. It runs inside a transaction that is
 * always rolled back, so the shared test database and its migration ledger stay
 * untouched. `0049` rebuilds an enum, which PostgreSQL only allows outside a
 * transaction block, so each statement is applied on its own.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { splitStatements } from "../../src/persistence/migrate";
import { dbDescribe, withRollback } from "../helpers/database";

function migrationSql(file: string): string {
  return readFileSync(resolve(process.cwd(), "migrations", file), "utf8");
}

/** The shape `0032` was written to cut over, which the current baseline no longer has. */
const REINSTATE_PRE_0032 = [
  'ALTER TABLE "provider_routing_settings" ADD COLUMN IF NOT EXISTS "credit_floor" integer',
  'ALTER TABLE "provider_routing_settings" DROP COLUMN IF EXISTS "credit_limit"',
  'ALTER TABLE "provider_routing_settings" DROP COLUMN IF EXISTS "credit_limit_enabled"',
  'ALTER TABLE "provider_accounts" ADD COLUMN IF NOT EXISTS "min_credit_balance" integer',
  'ALTER TABLE "provider_accounts" ADD COLUMN IF NOT EXISTS "last_remaining_credit" numeric(16, 4)',
  'ALTER TABLE "provider_accounts" ADD COLUMN IF NOT EXISTS "last_remaining_percent" numeric(8, 4)',
];

async function applyFile(
  client: { query: (text: string, values?: unknown[]) => Promise<unknown> },
  file: string,
): Promise<void> {
  for (const statement of splitStatements(migrationSql(file))) {
    await client.query(statement);
  }
}

async function columnNames(
  client: { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<{ column_name: string }> }> },
  table: string,
  names: readonly string[],
): Promise<string[]> {
  const result = await client.query(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = $1 and column_name = any($2::text[])
      order by column_name`,
    [table, names],
  );
  return result.rows.map((row) => row.column_name);
}

dbDescribe("migration: drop fusion and the minimum-balance floor", () => {
  test("an old credit floor survives 0032 and is then removed by 0049", async () => {
    await withRollback(async (client) => {
      for (const statement of REINSTATE_PRE_0032) await client.query(statement);
      const runId = `floor-${Date.now().toString(36)}`;
      const providerId = `cutover-${runId}`;
      await client.query(`insert into providers (id, enabled) values ($1, true)`, [providerId]);
      const tenant = await client.query(
        `insert into tenants (name, status) values ($1, 'active') returning id`,
        [`cutover-${runId}`],
      );
      const tenantId = tenant.rows[0]?.id as string | undefined;
      if (!tenantId) throw new Error("tenant insert returned no row");
      const accounts = await client.query<{ id: string }>(
        `insert into provider_accounts
           (provider_id, tenant_id, label, credential_kind, status, cooldown_until, model_cooldowns)
         values ($1, $2, 'a1', 'oauth', 'active', null, '{}')
         returning id`,
        [providerId, tenantId],
      );
      const accountId = accounts.rows[0]?.id;
      if (!accountId) throw new Error("account insert returned no row");
      await client.query(
        `update provider_accounts
            set min_credit_balance = 10, last_remaining_credit = 40, last_remaining_percent = 80
          where id = $1`,
        [accountId],
      );
      await client.query(
        `insert into provider_routing_settings (provider_id, tenant_id, strategy, enabled, credit_floor)
         values ($1, null, 'fallback', false, 100)`,
        [providerId],
      );

      await applyFile(client, "0032_global_credit_limit.sql");
      const carried = await client.query<{ credit_limit: number; credit_limit_enabled: boolean }>(
        `select credit_limit, credit_limit_enabled from provider_routing_settings
          where provider_id = $1 and tenant_id is null`,
        [providerId],
      );
      expect(carried.rows[0]?.credit_limit).toBe(100);
      expect(carried.rows[0]?.credit_limit_enabled).toBe(true);

      await applyFile(client, "0049_drop_fusion_and_minimum_balance.sql");

      expect(
        await columnNames(client, "provider_routing_settings", [
          "credit_floor",
          "credit_limit",
          "credit_limit_enabled",
        ]),
      ).toEqual([]);
      expect(
        await columnNames(client, "provider_accounts", [
          "min_credit_balance",
          "last_remaining_credit",
          "last_remaining_percent",
        ]),
      ).toEqual([]);
      const account = await client.query<{ id: string }>(
        `select id from provider_accounts where id = $1`,
        [accountId],
      );
      expect(account.rows).toHaveLength(1);
    });
  });

  test("a fusion combo becomes fallback and the enum loses fusion", async () => {
    // The shared enum cannot gain `fusion` inside the rollback transaction, and
    // committing that label would race every other suite. A scratch type with the
    // old membership is the pre-0049 column, and the tracked SQL is what cuts it over.
    await withRollback(async (client) => {
      // The rename takes the shared type out of the catalog until rollback.
      // The same lock the migration runner uses keeps other suites from applying
      // SQL against it in that window.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('cartethyia:migrations'))");
      await client.query(`ALTER TABLE "model_combos" ALTER COLUMN "strategy" DROP DEFAULT`);
      await client.query(`ALTER TABLE "model_combos" ALTER COLUMN "strategy" TYPE text USING "strategy"::text`);
      await client.query(`ALTER TYPE "model_combo_strategy" RENAME TO "model_combo_strategy_canonical"`);
      await client.query(
        `CREATE TYPE "model_combo_strategy" AS ENUM('fallback', 'round_robin', 'fusion')`,
      );
      await client.query(
        `ALTER TABLE "model_combos" ALTER COLUMN "strategy" TYPE "model_combo_strategy" USING "strategy"::"model_combo_strategy"`,
      );
      await client.query(`ALTER TABLE "model_combos" ALTER COLUMN "strategy" SET DEFAULT 'fallback'`);

      const tenant = await client.query(
        `insert into tenants (name, status) values ($1, 'active') returning id`,
        [`fusion-${Date.now().toString(36)}`],
      );
      const tenantId = tenant.rows[0]?.id as string | undefined;
      if (!tenantId) throw new Error("tenant insert returned no row");
      await client.query(
        `insert into model_combos (tenant_id, name, members, strategy)
         values
           ($1, 'panel', '["judge","a","b"]'::jsonb, 'fusion'),
           ($1, 'rotate', '["a","b"]'::jsonb, 'round_robin')`,
        [tenantId],
      );

      await applyFile(client, "0049_drop_fusion_and_minimum_balance.sql");

      const combos = await client.query<{ name: string; strategy: string }>(
        `select name, strategy::text as strategy from model_combos
          where tenant_id = $1 order by name`,
        [tenantId],
      );
      expect(combos.rows).toEqual([
        { name: "panel", strategy: "fallback" },
        { name: "rotate", strategy: "round_robin" },
      ]);
      const labels = await client.query<{ label: string }>(
        `select enumlabel as label from pg_enum
          where enumtypid = 'model_combo_strategy'::regtype
          order by enumsortorder`,
      );
      expect(labels.rows.map((row) => row.label)).toEqual(["fallback", "round_robin"]);
    });
  });
});
