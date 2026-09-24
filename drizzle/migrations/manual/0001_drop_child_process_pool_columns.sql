-- Hand-run once on any database created from the previous baseline.
--
-- The child-process pool flavor (v2ray/wireproxy daemon) was removed, so its
-- runtime bookkeeping columns, indexes, and checks are gone from
-- `0000_baseline.sql`. The migration ledger (`cartethyia_schema_migrations`)
-- already records `0000_baseline.sql` as applied, so `bun run db:migrate` will
-- NOT re-run the edited baseline — a live database keeps the old columns until
-- this runs.
--
-- `test/integration/isolated-db.test.ts` asserts the schema matches
-- `src/persistence/schema.ts`; it reports "Expected length: 229 / Received
-- length: 232" until this is applied. Run it against `DATABASE_URL` (and again
-- against `CARTETHYIA_TEST_DATABASE_URL` if that points at a separate DB):
--
--   bun run db:migrate   # no-op for the edited baseline, safe to run first
--   # then paste this file into psql, or run each statement below.

ALTER TABLE "network_pools" DROP COLUMN IF EXISTS "process_id";
ALTER TABLE "network_pools" DROP COLUMN IF EXISTS "socks_port";
ALTER TABLE "network_pools" DROP COLUMN IF EXISTS "runtime_status";

-- Dropping the columns drops their dependent indexes and CHECK constraints, but
-- the index names are dropped explicitly so a partially-applied run converges.
DROP INDEX IF EXISTS "network_pools_socks_port_uidx";
DROP INDEX IF EXISTS "network_pools_runtime_status_idx";

ALTER TABLE "network_pools" DROP CONSTRAINT IF EXISTS "network_pools_runtime_status_check";
ALTER TABLE "network_pools" DROP CONSTRAINT IF EXISTS "network_pools_socks_port_check";

-- The enum keeps only the kinds the in-process agents dial. Postgres cannot
-- drop an enum value in place, so the type is rebuilt. Safe to re-run: the
-- guard skips the rebuild once the values are gone.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'network_pool_kind'
      AND e.enumlabel IN ('wireguard', 'vmess_vless')
  ) THEN
    ALTER TYPE "public"."network_pool_kind" RENAME TO "network_pool_kind_old";
    CREATE TYPE "public"."network_pool_kind" AS ENUM('http', 'socks5');
    -- No row can hold a removed kind: the console only ever wrote http/socks5
    -- (https is normalized to http before insert), so the cast is total.
    ALTER TABLE "network_pools"
      ALTER COLUMN "kind" TYPE "public"."network_pool_kind"
      USING "kind"::text::"public"."network_pool_kind";
    DROP TYPE "public"."network_pool_kind_old";
  END IF;
END
$$;
