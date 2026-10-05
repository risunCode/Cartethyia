-- Global credit limit cutover.
--
-- `0031_per_account_credit_floor.sql` moved credit protection onto each account
-- (`provider_accounts.min_credit_balance`). Operators set one reserve per
-- account, but the intent is a single global minimum kept unused on *every*
-- account of a provider/tenant, so the setting moves back to
-- `provider_routing_settings` — this time as an explicit pair:
-- `credit_limit_enabled` (toggle) and `credit_limit` (value, default 200).
--
-- `provider_accounts.last_remaining_credit` stays: routing compares each
-- account's last fetched balance against the one global limit. The per-account
-- `min_credit_balance` column is dropped.
--
-- Idempotent: every step is guarded so a database that already recorded an
-- earlier file, or one that was created fresh from the updated baseline, is a
-- no-op rather than an error. A database that never had `credit_floor` (the
-- pre-`0026` shape) simply gets the two new columns at their defaults.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'provider_routing_settings' AND column_name = 'credit_limit_enabled'
  ) THEN
    ALTER TABLE "provider_routing_settings"
      ADD COLUMN "credit_limit_enabled" boolean DEFAULT true NOT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'provider_routing_settings' AND column_name = 'credit_limit'
  ) THEN
    ALTER TABLE "provider_routing_settings"
      ADD COLUMN "credit_limit" integer DEFAULT 200 NOT NULL;
  END IF;

  -- Carry a configured provider-level reserve forward as the global limit.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'provider_routing_settings' AND column_name = 'credit_floor'
  ) THEN
    UPDATE "provider_routing_settings"
    SET "credit_limit" = "credit_floor"
    WHERE "credit_floor" IS NOT NULL;

    ALTER TABLE "provider_routing_settings" DROP COLUMN "credit_floor";
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'provider_accounts' AND column_name = 'last_remaining_credit'
  ) THEN
    ALTER TABLE "provider_accounts" ADD COLUMN "last_remaining_credit" numeric(16, 4);
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'provider_accounts' AND column_name = 'min_credit_balance'
  ) THEN
    ALTER TABLE "provider_accounts" DROP COLUMN "min_credit_balance";
  END IF;
END $$;
