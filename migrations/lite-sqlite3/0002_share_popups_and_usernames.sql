-- SQLite twin of migrations/full-postgres/0002_share_popups_and_usernames.sql.
--
-- The popup copy and the index renames in the PostgreSQL file repair a
-- database built before the baseline. A SQLite database is never in that
-- state: its baseline already creates share_popups and the current index
-- names. What remains is the shape, restated so an older SQLite file converges.
CREATE TABLE IF NOT EXISTS "share_popups" (
  "api_key_id" text PRIMARY KEY REFERENCES "api_keys" ("id") ON DELETE CASCADE,
  "enabled" integer NOT NULL DEFAULT 0 CHECK ("enabled" IN (0, 1)),
  "image" blob,
  "image_mime" text,
  "title" text,
  "body" text,
  CONSTRAINT "share_popups_image_mime_check" CHECK ("image_mime" IS NULL OR "image_mime" IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  CONSTRAINT "share_popups_image_size_check" CHECK ("image" IS NULL OR length("image") <= 2097152)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "console_users_tenant_username_uidx"
  ON "console_users" ("tenant_id", "username");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "share_links_api_key_idx" ON "share_links" ("api_key_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "console_users_tenant_id_idx" ON "console_users" ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "console_sessions_user_id_idx" ON "console_sessions" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telemetry_events_created_at_idx" ON "telemetry_events" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_keys_enabled_tenant_idx" ON "api_keys" ("tenant_id") WHERE "enabled" = 1;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "health_events_account_model_created_idx"
  ON "health_events" ("account_id", "model_id", "created_at");
