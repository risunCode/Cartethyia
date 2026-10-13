-- 0012 rebuilt network_pools without copying this health timestamp. SQLite
-- migration application skips this add when the column already exists.
ALTER TABLE "network_pools" ADD COLUMN "last_error_at" text;
