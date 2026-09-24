-- Hand-run once on any database created before the `grok-cli` → `grok` rename.
--
-- The bundled provider id changed from `grok-cli` to `grok` (no backward-compat
-- alias, by design). Every row that references the provider by id still says
-- `grok-cli`, so dispatch, quota, and OAuth all lose their provider until this
-- runs:
--
--   * `providers`          — the provider row itself
--   * `provider_accounts`  — OAuth accounts (35 rows), plus their OAuth state
--                            rows which follow by `provider_account_id`
--   * `models`             — builtin catalog entries (3 rows)
--
-- Order matters. `provider_accounts.provider_id` and `models.provider_id` are
-- FKs to `providers.id` with no ON UPDATE CASCADE, so the parent row must
-- become `grok` before its children are re-pointed, and must not be deleted
-- while children still reference it.
--
-- Model rows are updated rather than left to the seeder: `seedBundledModels()`
-- upserts on `(provider_id, model_id, endpoint_path)` and deletes stale
-- `source = 'builtin'` rows, but renaming the provider leaves the old rows
-- under the old id where the deleter cannot see them. `enabled` is
-- operator-owned and would be lost on reinsert.
--
-- Safe to re-run: every statement is guarded or idempotent.
--
--   bun run db:migrate   # no-op for the baseline, safe to run first
--   # then paste this file into psql, or run each statement below.

-- 1. Create the new parent row first (copying the old row's config), so the
--    children below have something legal to point at.
INSERT INTO "providers" (
  "id", "tenant_id", "wire_family_default", "capability_profile",
  "base_url", "compatibility_profile", "enabled", "requires_account"
)
SELECT
  'grok', "tenant_id", "wire_family_default", "capability_profile",
  "base_url", "compatibility_profile", "enabled", "requires_account"
FROM "providers"
WHERE "id" = 'grok-cli'
  AND NOT EXISTS (SELECT 1 FROM "providers" p WHERE p."id" = 'grok');

-- 2. Re-point every child row at the new id.
UPDATE "provider_accounts"
   SET "provider_id" = 'grok'
 WHERE "provider_id" = 'grok-cli';

UPDATE "models"
   SET "provider_id" = 'grok'
 WHERE "provider_id" = 'grok-cli';

-- Any other provider-id-keyed configuration written by the console.
UPDATE "provider_routing_settings"
   SET "provider_id" = 'grok'
 WHERE "provider_id" = 'grok-cli';

-- 3. Now that nothing references it, drop the old provider row. Guarded so a
--    re-run (or a database that never had `grok-cli`) is a no-op.
DELETE FROM "providers"
 WHERE "id" = 'grok-cli'
   AND EXISTS (SELECT 1 FROM "providers" p WHERE p."id" = 'grok');
