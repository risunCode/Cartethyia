-- Fusion and the minimum-balance floor are gone. Existing fusion combos become
-- fallback so the row, its members, and its name survive the enum rewrite.
-- Postgres cannot drop one value from an enum, so the type is rebuilt.
UPDATE "model_combos" SET "strategy" = 'fallback' WHERE "strategy"::text = 'fusion';
--> statement-breakpoint
ALTER TYPE "model_combo_strategy" RENAME TO "model_combo_strategy_old";
--> statement-breakpoint
CREATE TYPE "model_combo_strategy" AS ENUM('fallback', 'round_robin');
--> statement-breakpoint
ALTER TABLE "model_combos" ALTER COLUMN "strategy" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "model_combos" ALTER COLUMN "strategy" TYPE "model_combo_strategy" USING "strategy"::text::"model_combo_strategy";
--> statement-breakpoint
ALTER TABLE "model_combos" ALTER COLUMN "strategy" SET DEFAULT 'fallback';
--> statement-breakpoint
DROP TYPE "model_combo_strategy_old";
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
