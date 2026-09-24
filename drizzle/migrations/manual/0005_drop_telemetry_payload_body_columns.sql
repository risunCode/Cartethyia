-- Hand-run once on any database created from the previous baseline.
--
-- `telemetry_payloads` carried four columns for the captured bodies
-- (`response_body`, `client_response_body`, `provider_request_body`,
-- `provider_response_body`) that no writer ever filled: `PayloadCapture.capture`
-- writes `{ _payload_ref }` into `request_body` and literal `null` into those
-- four, because the real bodies live in the frame file the reference points at.
-- The reader in `console/domains/stats/store.ts` overwrote all four from the
-- frame record, so they were structural storage that never held a value.
--
-- They are gone from `src/persistence/schema.ts` and from `0000_baseline.sql`,
-- so a database created from the current baseline never has them. The migration
-- ledger (`cartethyia_schema_migrations`) already records `0000_baseline.sql` as
-- applied, so `bun run db:migrate` will NOT re-run the edited baseline — a live
-- database keeps the columns until this runs.
--
-- `test/integration/isolated-db.test.ts` asserts the live schema matches
-- `src/persistence/schema.ts` exactly, including the total column count, so it
-- fails with a column-count mismatch until this is applied. Run it against
-- `DATABASE_URL` (and again against `CARTETHYIA_TEST_DATABASE_URL` if that
-- points at a separate database):
--
--   bun run db:migrate   # no-op for the edited baseline, safe to run first
--   # then paste this file into psql, or run the statements below.

-- No index or CHECK constraint depends on these columns, so each drop is a
-- single statement; `IF EXISTS` keeps a partially-applied or already-migrated
-- run convergent.
ALTER TABLE "telemetry_payloads" DROP COLUMN IF EXISTS "response_body";
ALTER TABLE "telemetry_payloads" DROP COLUMN IF EXISTS "client_response_body";
ALTER TABLE "telemetry_payloads" DROP COLUMN IF EXISTS "provider_request_body";
ALTER TABLE "telemetry_payloads" DROP COLUMN IF EXISTS "provider_response_body";
