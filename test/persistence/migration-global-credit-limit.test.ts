/**
 * Migration test: global credit limit cutover.
 *
 * `0031_per_account_credit_floor.sql` put credit protection on each account
 * (`provider_accounts.min_credit_balance`). This migration moves it back to a
 * single global pair on `provider_routing_settings` —
 * `credit_limit_enabled` + `credit_limit` (default 200) — carries a legacy
 * provider-level `credit_floor` forward, and drops `min_credit_balance`.
 * `provider_accounts.last_remaining_credit` stays: routing compares each
 * account's fetched balance against the one global limit.
 *
 * The SQL is read from the tracked file rather than restated, so the test
 * cannot drift from what a deployment actually runs. Applied inside a
 * transaction that is always rolled back, so the shared test database (and its
 * migration ledger) is untouched.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { dbDescribe, withRollback } from "../helpers/database";

const MIGRATION_FILE = "0032_global_credit_limit.sql";

function migrationSql(): string {
  return readFileSync(resolve(process.cwd(), "migrations", MIGRATION_FILE), "utf8");
}

/**
 * Recreates the pre-migration shape the file must cut over: the legacy
 * per-account column plus a provider-level `credit_floor`, with the two new
 * global columns absent.
 */
const REINSTATE_LEGACY_SHAPE = [
  'ALTER TABLE "provider_routing_settings" ADD COLUMN IF NOT EXISTS "credit_floor" integer',
  'ALTER TABLE "provider_routing_settings" DROP COLUMN IF EXISTS "credit_limit"',
  'ALTER TABLE "provider_routing_settings" DROP COLUMN IF EXISTS "credit_limit_enabled"',
  'ALTER TABLE "provider_accounts" ADD COLUMN IF NOT EXISTS "min_credit_balance" integer',
];

dbDescribe("migration: global credit limit cutover", () => {
  test("adds the global settings, migrates the legacy floor, and drops per-account floors", async () => {
    await withRollback(async (client) => {
      for (const statement of REINSTATE_LEGACY_SHAPE) await client.query(statement);
      const runId = `creditlimit-${Date.now().toString(36)}`;
      const providerId = `cutover-${runId}`;
      await client.query(`insert into providers (id, enabled) values ($1, true)`, [providerId]);
      const tenant = await client.query(
        `insert into tenants (name, status) values ($1, 'active') returning id`,
        [`cutover-${runId}`],
      );
      const tenantRow = tenant.rows[0];
      if (!tenantRow) throw new Error("tenant insert returned no row");
      const tenantId = tenantRow.id as string;
      const accounts = await client.query<{ id: string }>(
        `insert into provider_accounts
           (provider_id, tenant_id, label, credential_kind, status, cooldown_until, model_cooldowns)
         values ($1, $2, 'a1', 'oauth', 'active', null, '{}')
         returning id`,
        [providerId, tenantId],
      );
      const accountId = accounts.rows[0]?.id;
      if (!accountId) throw new Error("account insert returned no row");
      await client.query(`update provider_accounts set min_credit_balance = 10 where id = $1`, [
        accountId,
      ]);
      await client.query(
        `insert into provider_routing_settings (provider_id, tenant_id, strategy, enabled, credit_floor)
         values ($1, null, 'fallback', false, 100)`,
        [providerId],
      );

      await client.query(migrationSql());
      await client.query(migrationSql());

      const accountColumns = await client.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_name = $1 and column_name in ('min_credit_balance', 'last_remaining_credit')`,
        ["provider_accounts"],
      );
      expect(accountColumns.rows.map((row) => row.column_name)).toEqual([
        "last_remaining_credit",
      ]);

      const providerColumns = await client.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_name = 'provider_routing_settings'
           and column_name in ('credit_floor', 'credit_limit', 'credit_limit_enabled')`,
      );
      expect(providerColumns.rows.map((row) => row.column_name).sort()).toEqual([
        "credit_limit",
        "credit_limit_enabled",
      ]);

      const settings = await client.query<{ credit_limit: number; credit_limit_enabled: boolean }>(
        `select credit_limit, credit_limit_enabled from provider_routing_settings
         where provider_id = $1 and tenant_id is null`,
        [providerId],
      );
      expect(settings.rows[0]?.credit_limit).toBe(100);
      expect(settings.rows[0]?.credit_limit_enabled).toBe(true);
    });
  });
});
