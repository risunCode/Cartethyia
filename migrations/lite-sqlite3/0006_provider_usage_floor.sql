-- Per-provider usage floor. The runner skips an ADD COLUMN whose column
-- already exists, so this stays idempotent without IF NOT EXISTS, which this
-- SQLite build rejects.
ALTER TABLE "provider_routing_settings" ADD COLUMN "usage_floor" integer;
--> statement-breakpoint
ALTER TABLE "provider_routing_settings" ADD COLUMN "usage_floor_unit" text DEFAULT 'percent' NOT NULL;
