/**
 * Migration test: one model-access mode + one list.
 *
 * `api_keys` used to carry `model_allowlist` and `model_denylist` side by side,
 * leaving enforcement to pick a precedence. `0034_model_access_modes.sql`
 * collapses them into `model_access_mode` (`whitelist` | `blacklist`) plus a
 * single `model_list`, backfilling a non-empty denylist to `blacklist` and
 * everything else to `whitelist`, then dropping both legacy columns.
 *
 * The SQL is read from the tracked file rather than restated, so the test cannot
 * drift from what a deployment actually runs. Applied inside a transaction that
 * is always rolled back, so the shared test database (and its migration ledger)
 * is untouched. The file is run twice to prove its `IF NOT EXISTS` guards make
 * it idempotent.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { dbDescribe, withRollback } from "../helpers/database";

const MIGRATION_FILE = "0034_model_access_modes.sql";

function migrationSql(): string {
  return readFileSync(resolve(process.cwd(), "migrations", MIGRATION_FILE), "utf8");
}

/**
 * Recreates the pre-migration shape the file must cut over: the two legacy list
 * columns present, the two new columns absent.
 */
const REINSTATE_LEGACY_SHAPE = [
  'ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "model_allowlist" jsonb',
  'ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "model_denylist" jsonb',
  'ALTER TABLE "api_keys" DROP COLUMN IF EXISTS "model_list"',
  'ALTER TABLE "api_keys" DROP COLUMN IF EXISTS "model_access_mode"',
];

dbDescribe("migration: model access modes", () => {
  test("collapses the allow/deny pair into one mode + one list", async () => {
    await withRollback(async (client) => {
      for (const statement of REINSTATE_LEGACY_SHAPE) await client.query(statement);
      const runId = `accessmodes-${Date.now().toString(36)}`;
      const tenant = await client.query<{ id: string }>(
        `insert into tenants (name, status) values ($1, 'active') returning id`,
        [`accessmodes-${runId}`],
      );
      const tenantId = tenant.rows[0]?.id;
      if (!tenantId) throw new Error("tenant insert returned no row");

      // One key with a non-empty denylist (must become blacklist), one with an
      // allowlist only (must stay whitelist), and one with neither.
      const denied = await client.query<{ id: string }>(
        `insert into api_keys (tenant_id, key_mode, key_hash, label, scopes, model_denylist)
         values ($1, 'personal', $2, 'denied', '["routing:invoke"]'::jsonb, '["deepseek-chat"]'::jsonb)
         returning id`,
        [tenantId, `${runId}-denied`],
      );
      const allowed = await client.query<{ id: string }>(
        `insert into api_keys (tenant_id, key_mode, key_hash, label, scopes, model_allowlist)
         values ($1, 'personal', $2, 'allowed', '["routing:invoke"]'::jsonb, '["claude-sonnet-4-6"]'::jsonb)
         returning id`,
        [tenantId, `${runId}-allowed`],
      );
      const bare = await client.query<{ id: string }>(
        `insert into api_keys (tenant_id, key_mode, key_hash, label, scopes)
         values ($1, 'personal', $2, 'bare', '["routing:invoke"]'::jsonb)
         returning id`,
        [tenantId, `${runId}-bare`],
      );
      const deniedId = denied.rows[0]?.id;
      const allowedId = allowed.rows[0]?.id;
      const bareId = bare.rows[0]?.id;
      if (!deniedId || !allowedId || !bareId) throw new Error("key insert returned no row");

      await client.query(migrationSql());
      await client.query(migrationSql());

      // The legacy columns are gone; the new pair is present.
      const columns = await client.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_name = 'api_keys'
           and column_name in ('model_allowlist', 'model_denylist', 'model_access_mode', 'model_list')`,
      );
      expect(columns.rows.map((row) => row.column_name).sort()).toEqual([
        "model_access_mode",
        "model_list",
      ]);

      const rows = await client.query<{ label: string; model_access_mode: string; model_list: unknown }>(
        `select label, model_access_mode, model_list from api_keys where tenant_id = $1`,
        [tenantId],
      );
      const byLabel = new Map(rows.rows.map((row) => [row.label, row]));

      // A denylisted key becomes a blacklist carrying the old denylist.
      expect(byLabel.get("denied")?.model_access_mode).toBe("blacklist");
      expect(byLabel.get("denied")?.model_list).toEqual(["deepseek-chat"]);
      // An allowlisted key stays a whitelist carrying the old allowlist.
      expect(byLabel.get("allowed")?.model_access_mode).toBe("whitelist");
      expect(byLabel.get("allowed")?.model_list).toEqual(["claude-sonnet-4-6"]);
      // A key with neither defaults to whitelist with no list (all allowed).
      expect(byLabel.get("bare")?.model_access_mode).toBe("whitelist");
      expect(byLabel.get("bare")?.model_list).toBeNull();
    });
  });
});
