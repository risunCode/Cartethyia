-- Hand-run once on any database created from the previous baseline.
--
-- Proxy (network-pool) selection gains a per-tenant strategy mirroring the
-- account strategy in `provider_routing_settings`: `least_loaded` (the
-- weighted least-loaded scan with its rotating tie-break that has always run)
-- or `round_robin` (`rotate_count` requests per pool before advancing,
-- skipping capacity/cooldown pools the way account failover does). Behavior
-- does not change by itself: the table ships no rows and an absent row reads
-- as `least_loaded`.
--
-- The `pool_routing_strategy` type and `pool_routing_settings` table are part
-- of `0000_baseline.sql`, but the migration ledger
-- (`cartethyia_schema_migrations`) already records `0000_baseline.sql` as
-- applied, so `bun run db:migrate` will NOT re-run the edited baseline — a
-- live database keeps the old shape until this runs.
--
-- `test/integration/isolated-db.test.ts` asserts the live schema matches
-- `src/persistence/schema.ts` exactly, including the total column count, so it
-- fails until this is applied. Run it against `DATABASE_URL` (and again
-- against `CARTETHYIA_TEST_DATABASE_URL` if that points at a separate
-- database):
--
--   bun run db:migrate   # no-op for the edited baseline, safe to run first
--   # then paste this file into psql, or run the statements below.

DO $$ BEGIN
  CREATE TYPE "pool_routing_strategy" AS ENUM('least_loaded', 'round_robin');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "pool_routing_settings" (
  "tenant_id" uuid NOT NULL,
  "strategy" "pool_routing_strategy" DEFAULT 'least_loaded' NOT NULL,
  "rotate_count" integer DEFAULT 1 NOT NULL,
  CONSTRAINT "pool_routing_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade,
  CONSTRAINT "pool_routing_settings_tenant_id_pk" PRIMARY KEY ("tenant_id")
);
