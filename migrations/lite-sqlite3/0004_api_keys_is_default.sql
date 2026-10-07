-- SQLite twin of migrations/full-postgres/0004_api_keys_is_default.sql.
--
-- Adds `is_default` so the tenant's mandatory gateway key is identifiable by a
-- column instead of by its label. The partial unique index permits at most one
-- live default per tenant. A fresh baseline already has both, so each step is
-- a no-op there; an older SQLite file gains them here.
ALTER TABLE "api_keys" ADD COLUMN "is_default" integer NOT NULL DEFAULT 0 CHECK ("is_default" IN (0, 1));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_one_default_per_tenant_uidx"
  ON "api_keys" ("tenant_id")
  WHERE "is_default" = 1 AND "revoked_at" IS NULL;
--> statement-breakpoint
UPDATE "api_keys"
  SET "is_default" = 1
  WHERE "label" = 'Default Cartethyia API key'
    AND "revoked_at" IS NULL
    AND COALESCE("is_default", 0) = 0;
