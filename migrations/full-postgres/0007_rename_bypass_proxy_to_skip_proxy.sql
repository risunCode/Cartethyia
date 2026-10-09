-- Renames provider_routing_settings.bypass_proxy to skip_proxy.
--
-- The rename is load-bearing, not cosmetic: the field decides whether a
-- provider's candidates ever carry network_pool_ids, so "bypass proxy" read
-- backwards to operators who wanted the opposite of what the toggle did.
--
-- Postgres runs this file inside one transaction (src/persistence/db-pg.ts),
-- so the rename either lands or the migration is not recorded.
ALTER TABLE "provider_routing_settings" RENAME COLUMN "bypass_proxy" TO "skip_proxy";
