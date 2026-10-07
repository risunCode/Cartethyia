-- Forward migration for databases that already recorded an earlier file.
--
-- Payload frames are gzipped now, and a row names that encoding as
-- `jsonl-file`. The check only allowed `jsonb-file`, so a new capture would
-- be rejected by the database it was just written for. Rows written before
-- this stay `jsonb-file`; both are valid.

ALTER TABLE "telemetry_payloads" DROP CONSTRAINT "telemetry_payloads_storage_check";

ALTER TABLE "telemetry_payloads"
  ADD CONSTRAINT "telemetry_payloads_storage_check"
  CHECK ("storage" IN ('jsonb-file', 'jsonl-file'));
