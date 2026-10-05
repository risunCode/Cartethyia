-- Replace the per-key model allow/deny pair with one mode + one list.
--
-- `api_keys` carried `model_allowlist` and `model_denylist` side by side, and
-- enforcement had to decide precedence between them. That is two overlapping
-- policies for one question. Collapse to exactly two modes:
--
--   * `whitelist` — only the names in `model_list` may be used (empty = all);
--   * `blacklist` — the names in `model_list` are refused (empty = none).
--
-- Backfill preserves existing intent: a key with a non-empty denylist becomes
-- `blacklist` carrying that list; every other key becomes `whitelist` carrying
-- its old allowlist (an empty allowlist already meant "all models allowed", the
-- same meaning an empty whitelist has now). The two legacy columns are dropped.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_keys' AND column_name = 'model_access_mode'
  ) THEN
    ALTER TABLE "api_keys"
      ADD COLUMN "model_access_mode" text NOT NULL DEFAULT 'whitelist';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_keys' AND column_name = 'model_list'
  ) THEN
    ALTER TABLE "api_keys" ADD COLUMN "model_list" jsonb;
  END IF;

  -- Only migrate from the legacy columns when they still exist (a fresh
  -- baseline install never had them).
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_keys' AND column_name = 'model_denylist'
  ) THEN
    UPDATE "api_keys"
    SET "model_access_mode" = 'blacklist',
        "model_list" = "model_denylist"
    WHERE "model_denylist" IS NOT NULL
      AND jsonb_typeof("model_denylist") = 'array'
      AND jsonb_array_length("model_denylist") > 0;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_keys' AND column_name = 'model_allowlist'
  ) THEN
    UPDATE "api_keys"
    SET "model_list" = "model_allowlist"
    WHERE "model_list" IS NULL
      AND "model_allowlist" IS NOT NULL
      AND jsonb_typeof("model_allowlist") = 'array'
      AND jsonb_array_length("model_allowlist") > 0;

    ALTER TABLE "api_keys" DROP COLUMN "model_allowlist";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_keys' AND column_name = 'model_denylist'
  ) THEN
    ALTER TABLE "api_keys" DROP COLUMN "model_denylist";
  END IF;
END $$;
