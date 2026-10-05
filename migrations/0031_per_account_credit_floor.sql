-- Move the credit floor from provider-level routing settings to each account.
--
-- `provider_routing_settings.credit_floor` was a single reserve applied to
-- every account of a provider, but operators set different reserves per
-- account and accounts are spent independently. The setting moves to
-- `provider_accounts.min_credit_balance` (per-account floor), and the quota
-- sweep now also stamps the last remaining credit on the account row so the
-- request path can exclude an account whose cached balance is at or below its
-- floor. The provider-level column is dropped after copying any existing
-- non-null value onto the provider's global accounts as a starting floor.
--
-- Idempotent: every step is guarded so a partially-applied migration can be
-- re-run safely.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'provider_accounts' AND column_name = 'min_credit_balance'
  ) THEN
    ALTER TABLE "provider_accounts" ADD COLUMN "min_credit_balance" integer;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'provider_accounts' AND column_name = 'last_remaining_credit'
  ) THEN
    ALTER TABLE "provider_accounts" ADD COLUMN "last_remaining_credit" numeric(16, 4);
  END IF;

  -- Carry any configured provider-level reserve onto the provider's shared
  -- (tenant_id IS NULL) accounts before dropping the column. An account that
  -- already has its own floor keeps it.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'provider_routing_settings' AND column_name = 'credit_floor'
  ) THEN
    UPDATE "provider_accounts" AS a
    SET "min_credit_balance" = r."credit_floor"
    FROM "provider_routing_settings" AS r
    WHERE a."provider_id" = r."provider_id"
      AND r."credit_floor" IS NOT NULL
      AND a."min_credit_balance" IS NULL;

    ALTER TABLE "provider_routing_settings" DROP COLUMN "credit_floor";
  END IF;
END $$;
