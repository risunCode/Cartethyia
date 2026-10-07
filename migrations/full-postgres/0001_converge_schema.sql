-- Converge a database that already recorded the old baseline onto the current
-- shape. A fresh install runs 0000 and finds every step here a no-op.
--
-- Data that cannot be expressed in the new columns is folded first: native wire
-- rows become chat, degraded health becomes a recoverable cooldown, a non-empty
-- model denylist becomes blacklist, and an OAuth account with no refresh token
-- is marked static. Columns the current schema no longer has are dropped only
-- after that fold.

-- Retired enum labels. Postgres cannot drop one label, so the type is rebuilt
-- after the rows have moved.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'wire_family' AND e.enumlabel = 'native'
  ) THEN
    UPDATE "models" SET "wire_family" = 'chat' WHERE "wire_family"::text = 'native';
    UPDATE "providers" SET "wire_family_default" = 'chat' WHERE "wire_family_default"::text = 'native';
    ALTER TYPE "wire_family" RENAME TO "wire_family_old";
    CREATE TYPE "wire_family" AS ENUM('chat', 'responses', 'messages');
    ALTER TABLE "models" ALTER COLUMN "wire_family" DROP DEFAULT;
    ALTER TABLE "models" ALTER COLUMN "wire_family" TYPE "wire_family" USING "wire_family"::text::"wire_family";
    ALTER TABLE "providers" ALTER COLUMN "wire_family_default" TYPE "wire_family" USING "wire_family_default"::text::"wire_family";
    DROP TYPE "wire_family_old";
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'health_status' AND e.enumlabel = 'degraded'
  ) THEN
    UPDATE "provider_accounts"
       SET "status" = 'cooldown',
           "cooldown_until" = COALESCE("cooldown_until", now() + interval '1 minute')
     WHERE "status"::text = 'degraded';
    UPDATE "network_pools"
       SET "status" = 'cooldown',
           "cooldown_until" = COALESCE("cooldown_until", now() + interval '1 minute')
     WHERE "status"::text = 'degraded';
    UPDATE "health_events" SET "from_status" = 'cooldown' WHERE "from_status"::text = 'degraded';
    UPDATE "health_events" SET "to_status" = 'cooldown' WHERE "to_status"::text = 'degraded';
    ALTER TYPE "health_status" RENAME TO "health_status_old";
    CREATE TYPE "health_status" AS ENUM('active', 'cooldown', 'disabled');
    ALTER TABLE "provider_accounts" ALTER COLUMN "status" DROP DEFAULT;
    ALTER TABLE "provider_accounts" ALTER COLUMN "status" TYPE "health_status" USING "status"::text::"health_status";
    ALTER TABLE "provider_accounts" ALTER COLUMN "status" SET DEFAULT 'active';
    ALTER TABLE "network_pools" ALTER COLUMN "status" DROP DEFAULT;
    ALTER TABLE "network_pools" ALTER COLUMN "status" TYPE "health_status" USING "status"::text::"health_status";
    ALTER TABLE "network_pools" ALTER COLUMN "status" SET DEFAULT 'active';
    ALTER TABLE "health_events"
      ALTER COLUMN "from_status" TYPE "health_status" USING "from_status"::text::"health_status",
      ALTER COLUMN "to_status" TYPE "health_status" USING "to_status"::text::"health_status";
    DROP TYPE "health_status_old";
  END IF;

  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'network_pool_kind') THEN
    ALTER TYPE "network_pool_kind" ADD VALUE IF NOT EXISTS 'bridge';
  END IF;
END $$;
--> statement-breakpoint

-- Columns the current schema still has. Each add is a no-op once present.
ALTER TABLE "provider_routing_settings" ADD COLUMN IF NOT EXISTS "user_agent" text NOT NULL DEFAULT 'codex_cli_rs/0.156.1';
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "client_router_denylist" jsonb;
--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD COLUMN IF NOT EXISTS "auth_state" jsonb;
--> statement-breakpoint
ALTER TABLE "provider_oauth_states" ADD COLUMN IF NOT EXISTS "client_secret_ciphertext" bytea;
--> statement-breakpoint
ALTER TABLE "health_events" ADD COLUMN IF NOT EXISTS "model_id" text;
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "sort_index" integer;
--> statement-breakpoint
ALTER TABLE "model_combos" ADD COLUMN IF NOT EXISTS "sort_index" integer;
--> statement-breakpoint
ALTER TABLE "model_aliases" ADD COLUMN IF NOT EXISTS "sort_index" integer;
--> statement-breakpoint
ALTER TABLE "network_pools" ADD COLUMN IF NOT EXISTS "egress_ip" text;
--> statement-breakpoint
ALTER TABLE "network_pools" ADD COLUMN IF NOT EXISTS "quota_bytes" bigint;
--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD COLUMN IF NOT EXISTS "sort_index" integer;
--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN IF NOT EXISTS "service_kind" text;
--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD COLUMN IF NOT EXISTS "static_token" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "enabled" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE "network_pools" ADD COLUMN IF NOT EXISTS "last_speedtest_bytes" integer;
--> statement-breakpoint
ALTER TABLE "network_pools" ADD COLUMN IF NOT EXISTS "last_speedtest_duration_ms" integer;
--> statement-breakpoint
ALTER TABLE "network_pools" ADD COLUMN IF NOT EXISTS "last_speedtest_status" text;
--> statement-breakpoint
ALTER TABLE "network_pools" ADD COLUMN IF NOT EXISTS "last_speedtest_error" text;
--> statement-breakpoint
ALTER TABLE "network_pools" ADD COLUMN IF NOT EXISTS "last_speedtest_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "network_pools" ADD COLUMN IF NOT EXISTS "bytes_sent_total" bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "network_pools" ADD COLUMN IF NOT EXISTS "bytes_received_total" bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint

-- Ordering and service kind keep the sequence the rows already had.
UPDATE "api_keys" AS target
SET "sort_index" = ordered.idx
FROM (
  SELECT id, row_number() OVER (PARTITION BY tenant_id ORDER BY created_at, id) - 1 AS idx
  FROM "api_keys"
) AS ordered
WHERE target.id = ordered.id AND target.sort_index IS NULL;
--> statement-breakpoint
UPDATE "model_combos" AS target
SET "sort_index" = ordered.idx
FROM (
  SELECT id, row_number() OVER (PARTITION BY tenant_id ORDER BY created_at, id) - 1 AS idx
  FROM "model_combos"
) AS ordered
WHERE target.id = ordered.id AND target.sort_index IS NULL;
--> statement-breakpoint
UPDATE "model_aliases" AS target
SET "sort_index" = ordered.idx
FROM (
  SELECT id, row_number() OVER (PARTITION BY tenant_id ORDER BY created_at, id) - 1 AS idx
  FROM "model_aliases"
) AS ordered
WHERE target.id = ordered.id AND target.sort_index IS NULL;
--> statement-breakpoint
UPDATE "provider_accounts" AS target
SET "sort_index" = ordered.idx
FROM (
  SELECT id, row_number() OVER (
    PARTITION BY provider_id, coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)
    ORDER BY created_at, id
  ) - 1 AS idx
  FROM "provider_accounts"
) AS ordered
WHERE target.id = ordered.id AND target.sort_index IS NULL;
--> statement-breakpoint
UPDATE "models" SET "service_kind" = 'llm' WHERE "service_kind" IS NULL;
--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "sort_index" SET DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "sort_index" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "model_combos" ALTER COLUMN "sort_index" SET DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "model_combos" ALTER COLUMN "sort_index" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "model_aliases" ALTER COLUMN "sort_index" SET DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "model_aliases" ALTER COLUMN "sort_index" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "provider_accounts" ALTER COLUMN "sort_index" SET DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "provider_accounts" ALTER COLUMN "sort_index" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "models" ALTER COLUMN "service_kind" SET DEFAULT 'llm';
--> statement-breakpoint
ALTER TABLE "models" ALTER COLUMN "service_kind" SET NOT NULL;
--> statement-breakpoint

-- Model access is one mode plus one list. A non-empty denylist wins; otherwise
-- the old allowlist is the whitelist.
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "model_access_mode" text NOT NULL DEFAULT 'whitelist';
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "model_list" jsonb;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_keys' AND column_name = 'model_denylist'
  ) THEN
    UPDATE "api_keys"
    SET "model_access_mode" = 'blacklist', "model_list" = "model_denylist"
    WHERE "model_denylist" IS NOT NULL
      AND jsonb_typeof("model_denylist") = 'array'
      AND jsonb_array_length("model_denylist") > 0;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_keys' AND column_name = 'model_allowlist'
  ) THEN
    UPDATE "api_keys"
    SET "model_list" = "model_allowlist"
    WHERE "model_list" IS NULL
      AND "model_allowlist" IS NOT NULL
      AND jsonb_typeof("model_allowlist") = 'array'
      AND jsonb_array_length("model_allowlist") > 0;
  END IF;
END $$;
--> statement-breakpoint

-- Keys that held routing also held search, because the grant used to be implied.
-- Spell it out before a later save can drop it.
UPDATE "api_keys"
SET "scopes" = (
  SELECT jsonb_agg(entry)
  FROM (
    SELECT DISTINCT value AS entry
    FROM jsonb_array_elements_text("scopes") AS value
    UNION
    SELECT 'search:invoke'
  ) AS merged
)
WHERE "scopes" ? 'routing:invoke'
  AND NOT ("scopes" ? 'search:invoke');
--> statement-breakpoint

-- OAuth state can exist without a refresh token. Those accounts are static.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'provider_oauth_states' AND column_name = 'refresh_ciphertext' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "provider_oauth_states" ALTER COLUMN "refresh_ciphertext" DROP NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'provider_oauth_states' AND column_name = 'expires_at' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "provider_oauth_states" ALTER COLUMN "expires_at" DROP NOT NULL;
  END IF;
END $$;
--> statement-breakpoint
INSERT INTO "provider_oauth_states" ("provider_account_id", "refresh_ciphertext", "expires_at")
SELECT a."id", NULL, NULL
FROM "provider_accounts" a
WHERE a."credential_kind" = 'oauth'
  AND NOT EXISTS (
    SELECT 1 FROM "provider_oauth_states" s WHERE s."provider_account_id" = a."id"
  );
--> statement-breakpoint
UPDATE "provider_accounts" a
SET "static_token" = true
WHERE a."credential_kind" = 'oauth'
  AND EXISTS (
    SELECT 1 FROM "provider_oauth_states" s
    WHERE s."provider_account_id" = a."id" AND s."refresh_ciphertext" IS NULL
  );
--> statement-breakpoint
UPDATE "provider_accounts"
SET "last_error" = NULL, "last_error_category" = NULL, "last_error_at" = NULL
WHERE "static_token" = true AND "last_error_category" = 'oauth_reauth_required';
--> statement-breakpoint
UPDATE "provider_accounts"
SET "last_error_category" = 'auth_invalidated'
WHERE "last_error_category" = 'oauth_revoked';
--> statement-breakpoint

-- CLI mappings are per key. Rows with no key cannot be attributed, so they go.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'cli_tool_mappings' AND column_name = 'api_key_id'
  ) THEN
    DELETE FROM "cli_tool_mappings";
    DELETE FROM "cli_tool_settings";
    ALTER TABLE "cli_tool_mappings"
      ADD COLUMN "api_key_id" uuid NOT NULL REFERENCES "api_keys"("id") ON DELETE CASCADE;
    ALTER TABLE "cli_tool_settings"
      ADD COLUMN "api_key_id" uuid NOT NULL REFERENCES "api_keys"("id") ON DELETE CASCADE;
    ALTER TABLE "cli_tool_settings" DROP CONSTRAINT IF EXISTS "cli_tool_settings_tenant_id_tool_id_pk";
    ALTER TABLE "cli_tool_settings" DROP CONSTRAINT IF EXISTS "cli_tool_settings_pkey";
    ALTER TABLE "cli_tool_settings"
      ADD CONSTRAINT "cli_tool_settings_pkey" PRIMARY KEY ("tenant_id", "tool_id", "api_key_id");
  END IF;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "cli_tool_mappings_key";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cli_tool_mappings_key"
  ON "cli_tool_mappings" ("tenant_id", "tool_id", "api_key_id", "slot_key");
--> statement-breakpoint

-- Payload rows are a short-lived index into files. The old body column cannot
-- stay, and a row missing the typed reference is not readable.
ALTER TABLE "telemetry_payloads" ADD COLUMN IF NOT EXISTS "storage" text;
--> statement-breakpoint
ALTER TABLE "telemetry_payloads" ADD COLUMN IF NOT EXISTS "file" text;
--> statement-breakpoint
ALTER TABLE "telemetry_payloads" ADD COLUMN IF NOT EXISTS "offset" integer;
--> statement-breakpoint
ALTER TABLE "telemetry_payloads" ADD COLUMN IF NOT EXISTS "length" integer;
--> statement-breakpoint
ALTER TABLE "telemetry_payloads" ADD COLUMN IF NOT EXISTS "checksum" text;
--> statement-breakpoint
ALTER TABLE "telemetry_payloads" ADD COLUMN IF NOT EXISTS "version" integer;
--> statement-breakpoint
DELETE FROM "telemetry_payloads"
WHERE "storage" IS NULL OR "file" IS NULL OR "offset" IS NULL
   OR "length" IS NULL OR "checksum" IS NULL OR "version" IS NULL;
--> statement-breakpoint
ALTER TABLE "telemetry_payloads" DROP COLUMN IF EXISTS "request_body";
--> statement-breakpoint
ALTER TABLE "telemetry_payloads" ALTER COLUMN "storage" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "telemetry_payloads" ALTER COLUMN "file" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "telemetry_payloads" ALTER COLUMN "offset" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "telemetry_payloads" ALTER COLUMN "length" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "telemetry_payloads" ALTER COLUMN "checksum" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "telemetry_payloads" ALTER COLUMN "version" SET NOT NULL;
--> statement-breakpoint

-- Share links accept a personal handoff, and tenant status is a closed set.
ALTER TABLE "share_links" DROP CONSTRAINT IF EXISTS "share_links_kind_check";
--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_kind_check" CHECK ("kind" IN ('enroll', 'handoff'));
--> statement-breakpoint
ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_status_check";
--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_status_check" CHECK ("status" IN ('active', 'suspended', 'deleted'));
--> statement-breakpoint

-- Dead columns. Dropped after every fold that read them.
ALTER TABLE "api_keys" DROP COLUMN IF EXISTS "provider_allowlist";
--> statement-breakpoint
ALTER TABLE "api_keys" DROP COLUMN IF EXISTS "model_allowlist";
--> statement-breakpoint
ALTER TABLE "api_keys" DROP COLUMN IF EXISTS "model_denylist";
--> statement-breakpoint
ALTER TABLE "provider_accounts" DROP COLUMN IF EXISTS "max_inflight";
--> statement-breakpoint
ALTER TABLE "models" DROP COLUMN IF EXISTS "web_search";
--> statement-breakpoint
DELETE FROM "models" WHERE "provider_id" = 'autoclaw';
--> statement-breakpoint
DELETE FROM "providers" WHERE "id" = 'autoclaw';
