/**
 * The three forward files are the whole upgrade path.
 *
 * A database built from an older baseline still has the columns and enum labels
 * those files fold. Each file is read from disk and applied to a throwaway
 * database built from the current baseline, then folded *backwards* into the
 * old shape the upgrade has to survive — so the run proves convergence without
 * taking DDL locks on the shared test database, where an `ALTER` would queue
 * behind the reads other workers hold and deadlock against them.
 *
 * The baseline itself is not executed here as a migration: an existing database
 * records it without running it, which `baselineAlreadySatisfied` pins.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { baselineAlreadySatisfied, splitStatements } from "../../src/persistence/migrate";
import { dbDescribe, withScratchDatabase } from "../helpers/database";

function applyFile(
  client: { query: (text: string, values?: unknown[]) => Promise<unknown> },
  file: string,
): Promise<void> {
  const source = readFileSync(resolve(process.cwd(), "migrations", "full-postgres", file), "utf8");
  return splitStatements(source).reduce<Promise<void>>(
    (chain, statement) => chain.then(() => client.query(statement).then(() => undefined)),
    Promise.resolve(),
  );
}

dbDescribe("migration: three forward files", () => {
  test("an existing database records the current baseline instead of replaying it", () => {
    const applied = new Set(["0000_old_baseline.sql"]);
    expect(baselineAlreadySatisfied(applied, true)).toBe(true);
    expect(baselineAlreadySatisfied(new Set(["0000_baseline.sql"]), true)).toBe(false);
    expect(baselineAlreadySatisfied(applied, false)).toBe(false);
  });

  test("old columns fold into the current shape and the dead ones go", async () => {
    await withScratchDatabase(async (client) => {
      await client.query(`ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "model_allowlist" jsonb`);
      await client.query(`ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "model_denylist" jsonb`);
      await client.query(`ALTER TABLE "api_keys" DROP COLUMN IF EXISTS "model_list"`);
      await client.query(`ALTER TABLE "api_keys" DROP COLUMN IF EXISTS "model_access_mode"`);
      await client.query(`ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "share_popup_enabled" boolean`);
      await client.query(`ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "share_popup_title" text`);
      await client.query(`ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "share_popup_body" text`);
      await client.query(`ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "share_popup_image" bytea`);
      await client.query(`ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "share_popup_image_mime" text`);
      await client.query(
        `ALTER TABLE "provider_routing_settings" ADD COLUMN IF NOT EXISTS "credit_floor" integer`,
      );
      await client.query(`ALTER TABLE "model_combos" ALTER COLUMN "strategy" DROP DEFAULT`);
      await client.query(`ALTER TABLE "model_combos" ALTER COLUMN "strategy" TYPE text USING "strategy"::text`);
      await client.query(`ALTER TYPE "model_combo_strategy" RENAME TO "model_combo_strategy_canonical"`);
      await client.query(`CREATE TYPE "model_combo_strategy" AS ENUM('fallback', 'round_robin', 'fusion')`);
      await client.query(
        `ALTER TABLE "model_combos" ALTER COLUMN "strategy" TYPE "model_combo_strategy" USING "strategy"::"model_combo_strategy"`,
      );
      await client.query(`ALTER TABLE "model_combos" ALTER COLUMN "strategy" SET DEFAULT 'fallback'`);

      const runId = `converge-${Date.now().toString(36)}`;
      const tenant = await client.query<{ id: string }>(
        `insert into tenants (name, status) values ($1, 'active') returning id`,
        [runId],
      );
      const tenantId = tenant.rows[0]?.id;
      if (!tenantId) throw new Error("tenant insert returned no row");
      const denied = await client.query<{ id: string }>(
        `insert into api_keys
           (tenant_id, key_mode, key_hash, label, scopes, model_denylist, share_popup_enabled, share_popup_title)
         values ($1, 'personal', $2, 'denied', '["routing:invoke"]'::jsonb, '["deepseek-chat"]'::jsonb, true, 'hello')
         returning id`,
        [tenantId, `${runId}-denied`],
      );
      const keyId = denied.rows[0]?.id;
      if (!keyId) throw new Error("key insert returned no row");
      await client.query(
        `insert into model_combos (tenant_id, name, members, strategy)
         values ($1, 'panel', '["judge","a"]'::jsonb, 'fusion')`,
        [tenantId],
      );

      await applyFile(client, "0001_converge_schema.sql");
      await applyFile(client, "0002_share_popups_and_usernames.sql");
      await applyFile(client, "0003_drop_fusion_and_minimum_balance.sql");

      const key = await client.query<{ model_access_mode: string; model_list: unknown }>(
        `select model_access_mode, model_list from api_keys where id = $1`,
        [keyId],
      );
      expect(key.rows[0]?.model_access_mode).toBe("blacklist");
      expect(key.rows[0]?.model_list).toEqual(["deepseek-chat"]);
      const popup = await client.query<{ title: string }>(
        `select title from share_popups where api_key_id = $1`,
        [keyId],
      );
      expect(popup.rows[0]?.title).toBe("hello");
      const combo = await client.query<{ strategy: string }>(
        `select strategy::text as strategy from model_combos where tenant_id = $1`,
        [tenantId],
      );
      expect(combo.rows[0]?.strategy).toBe("fallback");
      const floor = await client.query(
        `select column_name from information_schema.columns
          where table_name = 'provider_routing_settings' and column_name = 'credit_floor'`,
      );
      expect(floor.rows).toHaveLength(0);
    });
  });
});
