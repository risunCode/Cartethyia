-- Hand-run once on any database created from the previous baseline.
--
-- Five schema artifacts that no code path read or wrote. Each was removed from
-- `0000_baseline.sql` so a fresh install no longer creates it; this file removes
-- it from a database created before that edit. Idempotent, so it is safe to run
-- more than once and safe on a database that never had them.
--
-- `console_users.last_login_at` — never written (the audit surface is
-- `admin_audit_log`) and never read.
--
-- `telemetry_payloads.redaction_applied` — written as a literal `true` on every
-- insert and read by nothing; redaction is a property of the capture path, not a
-- per-row flag.
--
-- `providers_capability_profile_gin_idx` — a GIN index on a jsonb column no
-- query ever applies a jsonb operator to, so it could only cost writes.
--
-- `idx_console_sessions_expires_at` / `idx_console_lockouts_locked_until` —
-- no query leads with these columns, and no expiry sweep exists to use them.
--
-- `tenant_disabled_models_tenant_idx` — redundant: the composite unique index
-- `tenant_disabled_models_tenant_provider_model_uidx` already leads with
-- `tenant_id`, so a `tenant_id`-only predicate is served by that prefix.

ALTER TABLE "console_users" DROP COLUMN IF EXISTS "last_login_at";
ALTER TABLE "telemetry_payloads" DROP COLUMN IF EXISTS "redaction_applied";

DROP INDEX IF EXISTS "providers_capability_profile_gin_idx";
DROP INDEX IF EXISTS "idx_console_sessions_expires_at";
DROP INDEX IF EXISTS "idx_console_lockouts_locked_until";
DROP INDEX IF EXISTS "tenant_disabled_models_tenant_idx";
