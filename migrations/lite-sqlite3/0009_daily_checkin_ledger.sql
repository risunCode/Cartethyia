-- Adds the daily check-in ledger.
--
-- One row per (account, calendar day) once the sweep has attempted that
-- account's daily claim. The day-scoped composite PK is the claim guard, so it
-- replaces the Redis `SET NX EX` the Lite backend never had: without it,
-- `reserveDaySlot` returned true without recording anything and the console
-- could only answer "unknown", which rendered as a permanent "Check-in due".
CREATE TABLE IF NOT EXISTS "daily_checkin_ledger" (
  "day_key" text NOT NULL,
  "account_id" text NOT NULL,
  "claimed_at" text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
  CONSTRAINT "daily_checkin_ledger_day_key_account_id_pk" PRIMARY KEY("day_key", "account_id")
);
