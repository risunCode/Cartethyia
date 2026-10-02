-- Add the `fusion` model-combo strategy.
--
-- A fusion combo runs its members as a panel: every panel model answers the
-- prompt in parallel, then one judge model (the combo's first member)
-- synthesizes a single final answer from the panel responses. It is a combo
-- *strategy* rather than a separate table because it selects among a combo's
-- existing members, exactly like `fallback` and `round_robin`.
--
-- Idempotent: `ADD VALUE IF NOT EXISTS` is a no-op when the value already
-- exists (e.g. a fresh install that ran the updated baseline). A `DO` block
-- guards the type's existence so a database that never created the enum (not
-- possible here, but safe) does not error.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'model_combo_strategy') THEN
    ALTER TYPE "model_combo_strategy" ADD VALUE IF NOT EXISTS 'fusion';
  END IF;
END $$;
