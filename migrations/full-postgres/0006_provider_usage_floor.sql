-- Per-provider usage floor. An account whose remaining allowance is at or
-- below the floor is skipped at routing time and the request fails over to the
-- next account. Null means no floor, which is every existing row.
ALTER TABLE "provider_routing_settings" ADD COLUMN IF NOT EXISTS "usage_floor" integer;
--> statement-breakpoint
ALTER TABLE "provider_routing_settings" ADD COLUMN IF NOT EXISTS "usage_floor_unit" text DEFAULT 'percent' NOT NULL;
