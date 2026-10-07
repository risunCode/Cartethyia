-- Fusion and the minimum-balance floor are gone. A fusion combo becomes
-- fallback so the row, its members, and its name survive. Postgres cannot drop
-- one enum label, so the type is rebuilt when the old label is still present.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'model_combo_strategy' AND e.enumlabel = 'fusion'
  ) THEN
    UPDATE "model_combos" SET "strategy" = 'fallback' WHERE "strategy"::text = 'fusion';
    ALTER TYPE "model_combo_strategy" RENAME TO "model_combo_strategy_old";
    CREATE TYPE "model_combo_strategy" AS ENUM('fallback', 'round_robin');
    ALTER TABLE "model_combos" ALTER COLUMN "strategy" DROP DEFAULT;
    ALTER TABLE "model_combos" ALTER COLUMN "strategy" TYPE "model_combo_strategy" USING "strategy"::text::"model_combo_strategy";
    ALTER TABLE "model_combos" ALTER COLUMN "strategy" SET DEFAULT 'fallback';
    DROP TYPE "model_combo_strategy_old";
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "provider_routing_settings" DROP COLUMN IF EXISTS "credit_limit_enabled";
--> statement-breakpoint
ALTER TABLE "provider_routing_settings" DROP COLUMN IF EXISTS "credit_limit";
--> statement-breakpoint
ALTER TABLE "provider_routing_settings" DROP COLUMN IF EXISTS "credit_floor";
--> statement-breakpoint
ALTER TABLE "provider_accounts" DROP COLUMN IF EXISTS "last_remaining_credit";
--> statement-breakpoint
ALTER TABLE "provider_accounts" DROP COLUMN IF EXISTS "last_remaining_percent";
--> statement-breakpoint
ALTER TABLE "provider_accounts" DROP COLUMN IF EXISTS "min_credit_balance";
