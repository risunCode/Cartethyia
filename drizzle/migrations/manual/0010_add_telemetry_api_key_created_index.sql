-- Adds the composite index `telemetry_events (api_key_id, created_at)`.
--
-- Why: the public share page aggregates one API key's usage straight off
-- `telemetry_events` — `share-usage.ts` filters `WHERE api_key_id = $1` and
-- computes `sum(...) filter (where created_at >= ...)`, `count(*) filter
-- (...)`, and `max(created_at)` over that slice. `telemetry_events` is the
-- largest table in the schema and had no index leading with `api_key_id`, so
-- every share-page render scanned the table (or at best used the
-- `created_at` index and re-checked the key per row).
--
-- Column order matters: `api_key_id` is the equality predicate and
-- `created_at` the range/aggregate, so the key leads and the timestamp
-- follows. The reverse order would not serve the filter.
--
-- Idempotent: safe to run more than once.
CREATE INDEX IF NOT EXISTS telemetry_events_api_key_created_idx
  ON telemetry_events (api_key_id, created_at);
