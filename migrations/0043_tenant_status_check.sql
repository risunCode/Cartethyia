-- `status` was free text. The only value any writer produces is `active`;
-- `suspended` and `deleted` are reserved so a later writer has a legal target
-- instead of inventing a fourth spelling.
ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_status_check";
--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_status_check"
  CHECK ("status" IN ('active', 'suspended', 'deleted'));
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now();
