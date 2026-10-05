-- Allow operators to pause API credentials without revoking or deleting them.
-- Existing keys remain enabled so this is a non-breaking schema cutover.
ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "enabled" boolean NOT NULL DEFAULT true;
