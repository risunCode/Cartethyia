-- Shared-key templates have no bearer hash. Child keys are real API keys linked
-- to a template and one globally unique active, canonical client-IP identity.
ALTER TABLE api_keys
  ALTER COLUMN key_hash DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS key_mode text NOT NULL DEFAULT 'personal',
  ADD COLUMN IF NOT EXISTS parent_key_id uuid,
  ADD COLUMN IF NOT EXISTS issued_client_ip text,
  ADD COLUMN IF NOT EXISTS issued_client_ip_key text;

DO $migration$
BEGIN
  ALTER TABLE api_keys
    ADD CONSTRAINT api_keys_parent_key_id_api_keys_id_fk
    FOREIGN KEY (parent_key_id) REFERENCES api_keys (id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END
$migration$;

DO $migration$
BEGIN
  ALTER TABLE api_keys
    ADD CONSTRAINT api_keys_mode_shape_check CHECK (
      (key_mode = 'personal' AND key_hash IS NOT NULL AND parent_key_id IS NULL
        AND issued_client_ip IS NULL AND issued_client_ip_key IS NULL)
      OR
      (key_mode = 'share' AND (
        (parent_key_id IS NULL AND key_hash IS NULL
          AND key_encrypted IS NULL
          AND issued_client_ip IS NULL AND issued_client_ip_key IS NULL)
        OR
        (parent_key_id IS NOT NULL AND key_hash IS NOT NULL
          AND key_encrypted IS NULL
          AND issued_client_ip IS NOT NULL AND issued_client_ip_key IS NOT NULL)
      ))
    );
EXCEPTION WHEN duplicate_object THEN
  NULL;
END
$migration$;

CREATE INDEX IF NOT EXISTS api_keys_parent_key_id_idx ON api_keys (parent_key_id);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_active_shared_ip_uidx
  ON api_keys (issued_client_ip_key)
  WHERE parent_key_id IS NOT NULL AND revoked_at IS NULL;

ALTER TABLE share_links ALTER COLUMN kind SET DEFAULT 'enroll';
UPDATE share_links SET active = false WHERE kind <> 'enroll';
UPDATE share_links SET kind = 'enroll' WHERE kind <> 'enroll';

DO $migration$
BEGIN
  ALTER TABLE share_links
    ADD CONSTRAINT share_links_kind_check CHECK (kind = 'enroll');
EXCEPTION WHEN duplicate_object THEN
  NULL;
END
$migration$;

CREATE INDEX IF NOT EXISTS telemetry_events_tenant_account_created_idx
  ON telemetry_events (tenant_id, account_id, created_at);
CREATE TABLE IF NOT EXISTS telemetry_usage_totals (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  identity_type text NOT NULL,
  entity_id uuid NOT NULL,
  requests bigint NOT NULL DEFAULT 0,
  errors bigint NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  last_used_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT telemetry_usage_totals_identity_pk
    PRIMARY KEY (tenant_id, identity_type, entity_id),
  CONSTRAINT telemetry_usage_totals_identity_type_check
    CHECK (identity_type IN ('account', 'api_key'))
);

INSERT INTO telemetry_usage_totals (
  tenant_id,
  identity_type,
  entity_id,
  requests,
  errors,
  input_tokens,
  output_tokens,
  last_used_at
)
SELECT
  tenant_id,
  'account',
  account_id,
  count(*),
  count(*) FILTER (WHERE status IN ('failed', 'truncated')),
  coalesce(sum(input_tokens), 0),
  coalesce(sum(output_tokens), 0),
  max(created_at)
FROM telemetry_events
WHERE account_id IS NOT NULL
GROUP BY tenant_id, account_id
UNION ALL
SELECT
  tenant_id,
  'api_key',
  api_key_id,
  count(*),
  count(*) FILTER (WHERE status IN ('failed', 'truncated')),
  coalesce(sum(input_tokens), 0),
  coalesce(sum(output_tokens), 0),
  max(created_at)
FROM telemetry_events
WHERE api_key_id IS NOT NULL
GROUP BY tenant_id, api_key_id
ON CONFLICT (tenant_id, identity_type, entity_id) DO NOTHING;
