-- Retire the `degraded` health status.
--
-- `degraded` sat between `active` and `cooldown` and meant different things to
-- different consumers: routing excluded it as a hard fault, `sweepExpiredCooldowns`
-- recovered it like a cooldown, and the console rendered it as its own badge.
-- Three readings of one value, which is what made it ambiguous to operate.
--
-- The two facts it carried are now each stated by a value that means one thing:
-- a self-clearing fault is `cooldown` (it carries `cooldown_until`, so the sweep
-- recovers it), and a fault needing an operator is `disabled`. Existing rows are
-- folded onto `cooldown` — never `disabled`, which would park an account that
-- was recovering on its own — and given a deadline if they had none, because a
-- `cooldown` row with a null `cooldown_until` is never selected by the sweep and
-- would stay cooling forever.
--
-- `health_status` is shared by `provider_accounts`, `network_pools`,
-- `health_events.from_status` and `health_events.to_status`, so all four columns
-- move to the replacement type. The history columns keep their rows: a past
-- event that recorded `degraded` is folded the same way, since the label no
-- longer exists to hold it.
--
-- Retry-safe: the guard makes a second run a no-op, and the enum rebuild is
-- skipped when `degraded` is already absent.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'health_status'
       AND e.enumlabel = 'degraded'
  ) THEN
    -- Fold every `degraded` row onto `cooldown` before the enum changes, and
    -- give a deadline to any row that lacks one so the sweep can recover it.
    UPDATE "public"."provider_accounts"
       SET "status" = 'cooldown',
           "cooldown_until" = COALESCE("cooldown_until", now() + interval '1 minute')
     WHERE "status"::text = 'degraded';

    UPDATE "public"."network_pools"
       SET "status" = 'cooldown',
           "cooldown_until" = COALESCE("cooldown_until", now() + interval '1 minute')
     WHERE "status"::text = 'degraded';

    UPDATE "public"."health_events"
       SET "from_status" = 'cooldown'
     WHERE "from_status"::text = 'degraded';

    UPDATE "public"."health_events"
       SET "to_status" = 'cooldown'
     WHERE "to_status"::text = 'degraded';

    -- Postgres cannot drop an enum label in place, so the type is rebuilt.
    -- The column default is dropped first because it would otherwise block the
    -- type swap on the two columns that carry one.
    ALTER TYPE "public"."health_status" RENAME TO "health_status_old";
    CREATE TYPE "public"."health_status" AS ENUM('active', 'cooldown', 'disabled');

    ALTER TABLE "public"."provider_accounts"
      ALTER COLUMN "status" DROP DEFAULT,
      ALTER COLUMN "status" TYPE "public"."health_status"
        USING "status"::text::"public"."health_status";

    ALTER TABLE "public"."network_pools"
      ALTER COLUMN "status" DROP DEFAULT,
      ALTER COLUMN "status" TYPE "public"."health_status"
        USING "status"::text::"public"."health_status";

    ALTER TABLE "public"."provider_accounts"
      ALTER COLUMN "status" SET DEFAULT 'active';

    ALTER TABLE "public"."network_pools"
      ALTER COLUMN "status" SET DEFAULT 'active';

    ALTER TABLE "public"."health_events"
      ALTER COLUMN "from_status" TYPE "public"."health_status"
        USING "from_status"::text::"public"."health_status",
      ALTER COLUMN "to_status" TYPE "public"."health_status"
        USING "to_status"::text::"public"."health_status";

    DROP TYPE "public"."health_status_old";
  END IF;
END
$$;
