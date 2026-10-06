-- The popup rode on `api_keys`, which the auth path reads on every request,
-- even though nearly every key has none. It moves to its own row. The copy
-- runs before the drop, so a database upgrading from 0046 loses nothing.
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
INSERT INTO "share_popups" ("api_key_id", "enabled", "image", "image_mime", "title", "body")
SELECT "id", "share_popup_enabled", "share_popup_image", "share_popup_image_mime", "share_popup_title", "share_popup_body"
FROM "api_keys"
WHERE "share_popup_enabled" = true
   OR "share_popup_image" IS NOT NULL
   OR "share_popup_title" IS NOT NULL
   OR "share_popup_body" IS NOT NULL
ON CONFLICT ("api_key_id") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "api_keys" DROP CONSTRAINT IF EXISTS "api_keys_share_popup_image_mime_check";
--> statement-breakpoint
ALTER TABLE "api_keys" DROP CONSTRAINT IF EXISTS "api_keys_share_popup_image_size_check";
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
