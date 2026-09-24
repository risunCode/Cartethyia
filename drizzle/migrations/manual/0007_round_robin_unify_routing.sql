-- Hand-run once on any database created from the previous baseline.
--
-- Provider routing had three strategies (`fallback`, `round_robin`, `sticky`)
-- where two of them did overlapping work: `sticky` pinned one account for a
-- TTL window while `round_robin` already serves N requests per account via its
-- rotation window. The strategies collapse to two — `fallback` (priority order,
-- fail through) and `round_robin` (rotate across accounts, `rotate_count`
-- requests per account before advancing).
--
-- Concretely: the `sticky` enum value is removed from
-- `provider_routing_strategy` (existing `sticky` rows become `fallback`, which
-- is the honest mapping — no pinning survives), `sticky_ttl_sec` is dropped
-- (nothing reads it anymore), and `sticky_set` is renamed to `rotate_count`.
--
-- They are gone from `src/persistence/schema.ts` and from `0000_baseline.sql`,
-- so a database created from the current baseline never has them. The migration
-- ledger (`cartethyia_schema_migrations`) already records `0000_baseline.sql` as
-- applied, so `bun run db:migrate` will NOT re-run the edited baseline — a live
-- database keeps the old shape until this runs.
--
-- `test/integration/isolated-db.test.ts` asserts the live schema matches
-- `src/persistence/schema.ts` exactly, including the total column count, so it
-- fails with a column-count mismatch until this is applied. Run it against
-- `DATABASE_URL` (and again against `CARTETHYIA_TEST_DATABASE_URL` if that
-- points at a separate database):
--
--   bun run db:migrate   # no-op for the edited baseline, safe to run first
--   # then paste this file into psql, or run the statements below.

-- Rows pinned by the removed strategy fall back to priority order.
UPDATE "provider_routing_settings" SET "strategy" = 'fallback' WHERE "strategy" = 'sticky';

-- Postgres cannot drop an enum value in one step while rows may reference it:
-- rename, recreate with the two surviving values, remap, then drop the old.
ALTER TYPE "provider_routing_strategy" RENAME TO "provider_routing_strategy_old";
CREATE TYPE "provider_routing_strategy" AS ENUM('fallback', 'round_robin');
ALTER TABLE "provider_routing_settings"
  ALTER COLUMN "strategy" TYPE "provider_routing_strategy"
  USING "strategy"::text::"provider_routing_strategy";
ALTER TABLE "provider_routing_settings" ALTER COLUMN "strategy" SET DEFAULT 'fallback';
DROP TYPE "provider_routing_strategy_old";

ALTER TABLE "provider_routing_settings" DROP COLUMN IF EXISTS "sticky_ttl_sec";
ALTER TABLE "provider_routing_settings" RENAME COLUMN "sticky_set" TO "rotate_count";
