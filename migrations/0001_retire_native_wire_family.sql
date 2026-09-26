-- Retire the `native` wire family.
--
-- `native` was never a protocol: it marked a row served by a bespoke adapter
-- (Cursor, Devin) that frames its own wire by hand, and no canonical codec had
-- a case for it. Because it sat in the same enum as the real families, the
-- console offered it as an operator choice and a request on it died inside the
-- codec with an untyped `unsupported wire family: native` rather than a typed
-- gateway error.
--
-- The fact it carried — "no canonical codec serves this row" — now lives on the
-- provider declaration (`bespokeWire` in the provider metadata, surfaced as
-- `capability_profile.bespokeWire`), which is where it belonged: it describes
-- the adapter, not the wire. Rows are folded onto `chat` first so the column
-- never holds a value the enum no longer accepts.
--
-- Retry-safe: the guard makes a second run a no-op, and the enum rebuild is
-- skipped when `native` is already absent.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'wire_family'
       AND e.enumlabel = 'native'
  ) THEN
    -- Fold every bespoke row onto a canonical value before the enum changes.
    UPDATE "public"."models" SET "wire_family" = 'chat' WHERE "wire_family"::text = 'native';
    UPDATE "public"."providers" SET "wire_family_default" = 'chat' WHERE "wire_family_default"::text = 'native';

    -- Postgres cannot drop an enum label in place, so the type is rebuilt.
    -- Both dependent columns are moved onto the replacement type; the default
    -- on `wire_family_default` is dropped first because it would otherwise
    -- block the type swap.
    ALTER TYPE "public"."wire_family" RENAME TO "wire_family_old";
    CREATE TYPE "public"."wire_family" AS ENUM('chat', 'responses', 'messages');

    ALTER TABLE "public"."models"
      ALTER COLUMN "wire_family" DROP DEFAULT,
      ALTER COLUMN "wire_family" TYPE "public"."wire_family"
        USING "wire_family"::text::"public"."wire_family";

    ALTER TABLE "public"."providers"
      ALTER COLUMN "wire_family_default" TYPE "public"."wire_family"
        USING "wire_family_default"::text::"public"."wire_family";

    DROP TYPE "public"."wire_family_old";
  END IF;
END
$$;
