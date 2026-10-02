-- Credit reserve per provider routing settings.
--
-- A credit-metered provider can now keep a floor of unused credits on every
-- account: when an account's remaining credit drops to or below the operator's
-- configured `credit_floor`, the quota sweep parks it in a 24h cooldown so
-- routing fails over instead of spending the account to empty. NULL (the
-- default, and every existing row) means no reserve.
--
-- Idempotent: guarded by an information_schema check so a database that already
-- has the column (e.g. a fresh install that ran the updated baseline) is a
-- no-op rather than an error.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'provider_routing_settings' AND column_name = 'credit_floor'
  ) THEN
    ALTER TABLE "provider_routing_settings" ADD COLUMN "credit_floor" integer;
  END IF;
END $$;
