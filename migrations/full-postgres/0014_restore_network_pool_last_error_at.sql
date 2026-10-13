-- Keep the network-pool health timestamp present on databases upgraded through
-- the SQLite pool-kind rebuild, which did not copy this column.
ALTER TABLE "network_pools" ADD COLUMN IF NOT EXISTS "last_error_at" timestamptz;
