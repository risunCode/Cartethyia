-- The one-time setup-link flow that wrote `used_at` is retired. No reader
-- remains, so the column is dead weight on every share-link row.
ALTER TABLE "share_links" DROP COLUMN IF EXISTS "used_at";
