-- Forward migration for databases that already recorded an earlier file.
--
-- Adds `is_default` to `api_keys` so the tenant's mandatory gateway key is
-- identifiable by a column instead of by its label. The partial unique index
-- permits at most one live default per tenant: a second insert fails rather
-- than leaving two keys both claiming to be the mandatory one.

ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "is_default" boolean DEFAULT false NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_one_default_per_tenant_uidx"
  ON "api_keys" USING btree ("tenant_id")
  WHERE "is_default" = true AND "revoked_at" IS NULL;

-- A key already seeded by an earlier build carried the reserved label and no
-- column. Promote it, so an existing installation keeps its key instead of
-- seeding a second one and failing the unique index.
UPDATE "api_keys"
  SET "is_default" = true
  WHERE "label" = 'Default Cartethyia API key'
    AND "revoked_at" IS NULL
    AND COALESCE("is_default", false) = false;
