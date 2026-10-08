-- Persisted speed-test measurements and metered byte totals per pool.
--
-- Speed-test results used to live only in the dashboard's localStorage, so a
-- reload elsewhere (or another browser) lost the last known throughput even
-- though measuring it cost real bytes off the operator's proxy plan. The last
-- measurement is now stored on the pool row next to the health-probe fields.
-- Mbps is derived from bytes/duration at read time, so only the raw pair is
-- stored.
--
-- bytes_sent_total / bytes_received_total accumulate the in-memory socket
-- byte counters (see src/network/pool/byte-accounting.ts) into the row on
-- every pool-touching write, so the quota bar has a denominator AND a
-- numerator that survive a gateway restart. NULL-able with a 0 default via
-- the Drizzle schema; the forward migration backfills nothing because SUM
-- over no rows reads as 0 through COALESCE at the single read site that
-- needs it (the store maps NULL to 0).
ALTER TABLE network_pools ADD COLUMN IF NOT EXISTS last_speedtest_bytes integer;
ALTER TABLE network_pools ADD COLUMN IF NOT EXISTS last_speedtest_duration_ms integer;
ALTER TABLE network_pools ADD COLUMN IF NOT EXISTS last_speedtest_status text;
ALTER TABLE network_pools ADD COLUMN IF NOT EXISTS last_speedtest_error text;
ALTER TABLE network_pools ADD COLUMN IF NOT EXISTS last_speedtest_at timestamptz;
ALTER TABLE network_pools ADD COLUMN IF NOT EXISTS bytes_sent_total bigint NOT NULL DEFAULT 0;
ALTER TABLE network_pools ADD COLUMN IF NOT EXISTS bytes_received_total bigint NOT NULL DEFAULT 0;
