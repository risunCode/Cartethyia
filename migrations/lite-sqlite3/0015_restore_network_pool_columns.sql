-- 0012 rebuilt network_pools without copying columns added by earlier
-- migrations. Restore the operational fields required by the live schema.
ALTER TABLE "network_pools" ADD COLUMN "last_health_check_at" text;
--> statement-breakpoint
ALTER TABLE "network_pools" ADD COLUMN "egress_ip" text;
--> statement-breakpoint
ALTER TABLE "network_pools" ADD COLUMN "quota_bytes" integer;
--> statement-breakpoint
ALTER TABLE "network_pools" ADD COLUMN "last_speedtest_bytes" integer;
--> statement-breakpoint
ALTER TABLE "network_pools" ADD COLUMN "last_speedtest_duration_ms" integer;
--> statement-breakpoint
ALTER TABLE "network_pools" ADD COLUMN "last_speedtest_status" text;
--> statement-breakpoint
ALTER TABLE "network_pools" ADD COLUMN "last_speedtest_error" text;
--> statement-breakpoint
ALTER TABLE "network_pools" ADD COLUMN "last_speedtest_at" text;
--> statement-breakpoint
ALTER TABLE "network_pools" ADD COLUMN "bytes_sent_total" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "network_pools" ADD COLUMN "bytes_received_total" integer NOT NULL DEFAULT 0;
