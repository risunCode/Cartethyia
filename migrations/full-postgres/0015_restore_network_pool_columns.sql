-- 0012 rebuilt network_pools without copying columns added by earlier
-- migrations. Restore the operational fields required by the live schema.
ALTER TABLE "network_pools" ADD COLUMN IF NOT EXISTS "last_health_check_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "network_pools" ADD COLUMN IF NOT EXISTS "egress_ip" text;
--> statement-breakpoint
ALTER TABLE "network_pools" ADD COLUMN IF NOT EXISTS "quota_bytes" bigint;
--> statement-breakpoint
ALTER TABLE "network_pools" ADD COLUMN IF NOT EXISTS "last_speedtest_bytes" integer;
--> statement-breakpoint
ALTER TABLE "network_pools" ADD COLUMN IF NOT EXISTS "last_speedtest_duration_ms" integer;
--> statement-breakpoint
ALTER TABLE "network_pools" ADD COLUMN IF NOT EXISTS "last_speedtest_status" text;
--> statement-breakpoint
ALTER TABLE "network_pools" ADD COLUMN IF NOT EXISTS "last_speedtest_error" text;
--> statement-breakpoint
ALTER TABLE "network_pools" ADD COLUMN IF NOT EXISTS "last_speedtest_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "network_pools" ADD COLUMN IF NOT EXISTS "bytes_sent_total" bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "network_pools" ADD COLUMN IF NOT EXISTS "bytes_received_total" bigint NOT NULL DEFAULT 0;
