-- Share popups leave api_keys, and usernames are unique per tenant.
-- The copy runs before the drop, so an older database loses no popup.

CREATE TABLE IF NOT EXISTS "share_popups" (
  "api_key_id" uuid PRIMARY KEY REFERENCES "api_keys" ("id") ON DELETE CASCADE,
  "enabled" boolean NOT NULL DEFAULT false,
  "image" bytea,
  "image_mime" text,
  "title" text,
  "body" text,
  CONSTRAINT "share_popups_image_mime_check" CHECK ("image_mime" IS NULL OR "image_mime" IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  CONSTRAINT "share_popups_image_size_check" CHECK ("image" IS NULL OR octet_length("image") <= 2097152)
);
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_keys' AND column_name = 'share_popup_enabled'
  ) THEN
    INSERT INTO "share_popups" ("api_key_id", "enabled", "image", "image_mime", "title", "body")
    SELECT "id",
           COALESCE("share_popup_enabled", false),
           "share_popup_image",
           "share_popup_image_mime",
           "share_popup_title",
           "share_popup_body"
    FROM "api_keys"
    WHERE "share_popup_enabled" = true
       OR "share_popup_image" IS NOT NULL
       OR "share_popup_title" IS NOT NULL
       OR "share_popup_body" IS NOT NULL
    ON CONFLICT ("api_key_id") DO NOTHING;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "api_keys" DROP CONSTRAINT IF EXISTS "api_keys_share_popup_image_mime_check";
--> statement-breakpoint
ALTER TABLE "api_keys" DROP CONSTRAINT IF EXISTS "api_keys_share_popup_image_size_check";
--> statement-breakpoint
ALTER TABLE "api_keys" DROP COLUMN IF EXISTS "share_popup_mode";
--> statement-breakpoint
ALTER TABLE "api_keys" DROP COLUMN IF EXISTS "share_popup_image_url";
--> statement-breakpoint
ALTER TABLE "api_keys" DROP COLUMN IF EXISTS "share_popup_action_label";
--> statement-breakpoint
ALTER TABLE "api_keys" DROP COLUMN IF EXISTS "share_popup_action_url";
--> statement-breakpoint
ALTER TABLE "api_keys" DROP COLUMN IF EXISTS "share_popup_enabled";
--> statement-breakpoint
ALTER TABLE "api_keys" DROP COLUMN IF EXISTS "share_popup_image";
--> statement-breakpoint
ALTER TABLE "api_keys" DROP COLUMN IF EXISTS "share_popup_image_mime";
--> statement-breakpoint
ALTER TABLE "api_keys" DROP COLUMN IF EXISTS "share_popup_title";
--> statement-breakpoint
ALTER TABLE "api_keys" DROP COLUMN IF EXISTS "share_popup_body";
--> statement-breakpoint
ALTER TABLE "share_links" DROP COLUMN IF EXISTS "used_at";
--> statement-breakpoint

-- The old username index was global. Existing rows already satisfy the wider
-- per-tenant constraint, so nothing is rewritten.
DROP INDEX IF EXISTS "idx_console_users_username";
--> statement-breakpoint
DROP INDEX IF EXISTS "console_users_username_uidx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "console_users_tenant_username_uidx"
  ON "console_users" ("tenant_id", "username");
--> statement-breakpoint

-- Indexes the current baseline declares. Rename the old spelling when it is
-- still there; otherwise create the current one.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_share_links_api_key') THEN
    ALTER INDEX "idx_share_links_api_key" RENAME TO "share_links_api_key_idx";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_share_links_active') THEN
    ALTER INDEX "idx_share_links_active" RENAME TO "share_links_active_kind_expires_idx";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_console_users_tenant_id') THEN
    ALTER INDEX "idx_console_users_tenant_id" RENAME TO "console_users_tenant_id_idx";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_console_sessions_user_id') THEN
    ALTER INDEX "idx_console_sessions_user_id" RENAME TO "console_sessions_user_id_idx";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_telemetry_created_at') THEN
    ALTER INDEX "idx_telemetry_created_at" RENAME TO "telemetry_events_created_at_idx";
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "share_links_api_key_idx" ON "share_links" ("api_key_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "console_users_tenant_id_idx" ON "console_users" ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "console_sessions_user_id_idx" ON "console_sessions" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telemetry_events_created_at_idx" ON "telemetry_events" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_keys_enabled_tenant_idx" ON "api_keys" ("tenant_id") WHERE "enabled" = true;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "health_events_account_model_created_idx"
  ON "health_events" ("account_id", "model_id", "created_at" DESC);
