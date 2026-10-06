-- These constraints already exist on databases that ran 0016. Declaring them
-- again, idempotently, converges a database restored from an older baseline
-- with the schema source of truth.
ALTER TABLE "api_keys" DROP CONSTRAINT IF EXISTS "api_keys_share_popup_image_mime_check";
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_share_popup_image_mime_check"
  CHECK ("share_popup_image_mime" IS NULL
    OR "share_popup_image_mime" IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif'));
--> statement-breakpoint
ALTER TABLE "api_keys" DROP CONSTRAINT IF EXISTS "api_keys_share_popup_image_size_check";
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_share_popup_image_size_check"
  CHECK ("share_popup_image" IS NULL OR octet_length("share_popup_image") <= 2097152);
