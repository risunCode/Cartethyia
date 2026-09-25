CREATE EXTENSION IF NOT EXISTS "pgcrypto";
--> statement-breakpoint
CREATE TYPE "public"."credential_kind" AS ENUM('api_key', 'oauth', 'none');
--> statement-breakpoint
CREATE TYPE "public"."health_entity_kind" AS ENUM('account', 'pool');
--> statement-breakpoint
CREATE TYPE "public"."health_status" AS ENUM('active', 'degraded', 'cooldown', 'disabled');
--> statement-breakpoint
CREATE TYPE "public"."network_pool_kind" AS ENUM('http', 'socks5');
--> statement-breakpoint
CREATE TYPE "public"."pool_routing_strategy" AS ENUM('least_loaded', 'round_robin');
--> statement-breakpoint
CREATE TYPE "public"."telemetry_source_surface" AS ENUM('chat', 'responses', 'messages', 'completion');
--> statement-breakpoint
CREATE TYPE "public"."telemetry_status" AS ENUM('completed', 'failed', 'cancelled', 'truncated');
--> statement-breakpoint
CREATE TYPE "public"."wire_family" AS ENUM('chat', 'responses', 'messages', 'native');
--> statement-breakpoint
CREATE TYPE "public"."model_combo_strategy" AS ENUM('fallback', 'round_robin');
--> statement-breakpoint
CREATE TYPE "public"."provider_routing_strategy" AS ENUM('fallback', 'round_robin');
--> statement-breakpoint
CREATE TABLE "tenants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "status" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "providers" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" uuid,
  "wire_family_default" "wire_family",
  "capability_profile" jsonb,
  "base_url" text,
  "compatibility_profile" jsonb,
  "enabled" boolean DEFAULT true NOT NULL,
  "requires_account" boolean DEFAULT true NOT NULL,
  CONSTRAINT "providers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE "provider_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider_id" text NOT NULL,
  "tenant_id" uuid,
  "label" text NOT NULL,
  "credential_ciphertext" bytea,
  "credential_fingerprint" text,
  "credential_kind" "credential_kind" NOT NULL,
  "status" "health_status" DEFAULT 'active' NOT NULL,
  "consecutive_failures" integer DEFAULT 0 NOT NULL,
  "last_success_at" timestamptz,
  "last_error" text,
  "last_error_category" text,
  "last_error_at" timestamptz,
  "cooldown_until" timestamptz,
  "last_recovered_at" timestamptz,
  "model_cooldowns" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "max_inflight" integer,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "provider_accounts_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE cascade,
  CONSTRAINT "provider_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE "provider_oauth_states" (
  "provider_account_id" uuid PRIMARY KEY NOT NULL,
  "refresh_ciphertext" bytea NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "lease_owner" text,
  "lease_expires_at" timestamptz,
  CONSTRAINT "provider_oauth_states_provider_account_id_provider_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "provider_accounts"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE "models" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider_id" text NOT NULL,
  "model_id" text NOT NULL,
  "wire_family" "wire_family" NOT NULL,
  "endpoint_path" text NOT NULL,
  "context_limit" integer,
  "output_limit" integer,
  "modalities" jsonb,
  "reasoning" boolean DEFAULT false NOT NULL,
  "tool_call" boolean DEFAULT false NOT NULL,
  "web_search" boolean DEFAULT false NOT NULL,
  "cost" jsonb,
  "source" text,
  "source_updated_at" timestamptz,
  "enabled" boolean DEFAULT true NOT NULL,
  CONSTRAINT "models_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE "tenant_disabled_models" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "provider_id" text NOT NULL,
  "model_id" text NOT NULL,
  "endpoint_path" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "tenant_disabled_models_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade,
  CONSTRAINT "tenant_disabled_models_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE "network_pools" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" "network_pool_kind" NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "endpoint_config" jsonb NOT NULL,
  "credential_ciphertext" bytea,
  "max_inflight" integer,
  "weight" integer,
  "tenant_id" uuid NOT NULL,
  "status" "health_status" DEFAULT 'active' NOT NULL,
  "consecutive_failures" integer DEFAULT 0 NOT NULL,
  "last_success_at" timestamptz,
  "last_latency_ms" integer,
  "last_error" text,
  "last_error_category" text,
  "last_error_at" timestamptz,
  "cooldown_until" timestamptz,
  "last_recovered_at" timestamptz,
  "last_health_check_at" timestamptz,
  CONSTRAINT "network_pools_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE "health_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "entity_kind" "health_entity_kind" NOT NULL,
  "account_id" uuid,
  "network_pool_id" uuid,
  "from_status" "health_status",
  "to_status" "health_status" NOT NULL,
  "reason" text,
  "error_category" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "health_events_account_id_provider_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "provider_accounts"("id") ON DELETE cascade,
  CONSTRAINT "health_events_network_pool_id_network_pools_id_fk" FOREIGN KEY ("network_pool_id") REFERENCES "network_pools"("id") ON DELETE cascade,
  CONSTRAINT "health_events_entity_reference_check" CHECK (("entity_kind" = 'account' AND "account_id" IS NOT NULL AND "network_pool_id" IS NULL) OR ("entity_kind" = 'pool' AND "network_pool_id" IS NOT NULL AND "account_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "model_aliases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "alias" text NOT NULL,
  "target_model" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "model_aliases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE "model_combos" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "name" text NOT NULL,
  "members" jsonb NOT NULL,
  "strategy" "model_combo_strategy" DEFAULT 'fallback' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "model_combos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE "provider_routing_settings" (
  "provider_id" text NOT NULL,
  "tenant_id" uuid,
  "strategy" "provider_routing_strategy" DEFAULT 'fallback' NOT NULL,
  "rotate_count" integer DEFAULT 1 NOT NULL,
  "max_inflight" integer,
  "enabled" boolean DEFAULT false NOT NULL,
  "bypass_proxy" boolean DEFAULT false NOT NULL,
  CONSTRAINT "provider_routing_settings_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE cascade,
  CONSTRAINT "provider_routing_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE "pool_routing_settings" (
  "tenant_id" uuid NOT NULL,
  "strategy" "pool_routing_strategy" DEFAULT 'least_loaded' NOT NULL,
  "rotate_count" integer DEFAULT 1 NOT NULL,
  CONSTRAINT "pool_routing_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade,
  CONSTRAINT "pool_routing_settings_tenant_id_pk" PRIMARY KEY ("tenant_id")
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "key_hash" text,
  "key_mode" text DEFAULT 'personal' NOT NULL,
  "parent_key_id" uuid,
  "issued_client_ip" text,
  "issued_client_ip_key" text,
  "label" text NOT NULL,
  "scopes" jsonb NOT NULL,
  "requests_per_minute" integer,
  "daily_token_limit" bigint,
  "monthly_token_limit" bigint,
  "lifetime_token_budget" bigint,
  "lifetime_tokens_consumed" bigint DEFAULT 0 NOT NULL,
  "max_concurrent_requests" integer,
  "provider_allowlist" jsonb,
  "model_allowlist" jsonb,
  "model_denylist" jsonb,
  "model_prefix" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "revoked_at" timestamptz,
  "key_prefix" text,
  "key_encrypted" bytea,
  "notes_title" text,
  "notes_subtitle" text,
  "notes_body" text,
  CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade,
  CONSTRAINT "api_keys_parent_key_id_api_keys_id_fk" FOREIGN KEY ("parent_key_id") REFERENCES "api_keys"("id") ON DELETE cascade,
  CONSTRAINT "api_keys_mode_shape_check" CHECK (
    ("key_mode" = 'personal' AND "key_hash" IS NOT NULL AND "parent_key_id" IS NULL
      AND "issued_client_ip" IS NULL AND "issued_client_ip_key" IS NULL)
    OR
    ("key_mode" = 'share' AND (
      ("parent_key_id" IS NULL AND "key_hash" IS NULL
        AND "key_encrypted" IS NULL
        AND "issued_client_ip" IS NULL AND "issued_client_ip_key" IS NULL)
      OR
      ("parent_key_id" IS NOT NULL AND "key_hash" IS NOT NULL
        AND "key_encrypted" IS NULL
        AND "issued_client_ip" IS NOT NULL AND "issued_client_ip_key" IS NOT NULL)
    ))
  )
);
--> statement-breakpoint
CREATE TABLE "console_users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "username" text NOT NULL,
  "email" text,
  "password_hash" text NOT NULL,
  "display_name" text,
  "is_active" boolean DEFAULT true NOT NULL,
  "is_platform_admin" boolean DEFAULT false NOT NULL,
  "is_first_boot" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "console_users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE "console_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "session_token" text NOT NULL UNIQUE,
  "ip_address" text,
  "user_agent" text,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "console_sessions_user_id_console_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "console_users"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE "console_lockouts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "ip" text NOT NULL,
  "failure_count" integer DEFAULT 0 NOT NULL,
  "window_until" timestamptz,
  "locked_until" timestamptz,
  "reason" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "console_settings" (
  "tenant_id" uuid PRIMARY KEY NOT NULL,
  "preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "console_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE "cli_tool_mappings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "tool_id" text NOT NULL,
  "slot_key" text NOT NULL,
  "source_model" text NOT NULL,
  "target_model" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "cli_tool_mappings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE "cli_tool_settings" (
  "tenant_id" uuid NOT NULL,
  "tool_id" text NOT NULL,
  "mappings_enabled" boolean DEFAULT false NOT NULL,
  "mode" text DEFAULT 'remote' NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "cli_tool_settings_tenant_id_tool_id_pk" PRIMARY KEY ("tenant_id", "tool_id"),
  CONSTRAINT "cli_tool_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE "admin_audit_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "actor" text NOT NULL,
  "tenant_id" uuid,
  "action" text NOT NULL,
  "target" text NOT NULL,
  "detail" jsonb,
  CONSTRAINT "admin_audit_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE "telemetry_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "request_id" uuid NOT NULL,
  "source_surface" "telemetry_source_surface",
  "requested_model" text,
  "provider_id" text,
  "account_id" uuid,
  "network_pool_id" uuid,
  "endpoint" text,
  "api_key_id" uuid,
  "user_agent" text,
  "client_ip" text,
  "latency_ms" integer,
  "ttfb_ms" integer,
  "stream" boolean,
  "status" "telemetry_status",
  "http_status" integer,
  "error_category" text,
  "error_origin" text,
  "input_tokens" integer,
  "cached_input_tokens" integer,
  "output_tokens" integer,
  "reasoning_tokens" integer,
  "estimated_cost_usd" numeric(12, 6),
  "tokens_per_sec" numeric(10, 2),
  "first_content_delta_at_ms" bigint,
  "last_event_at_ms" bigint,
  CONSTRAINT "telemetry_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE "telemetry_usage_totals" (
  "tenant_id" uuid NOT NULL,
  "identity_type" text NOT NULL,
  "entity_id" uuid NOT NULL,
  "requests" bigint DEFAULT 0 NOT NULL,
  "errors" bigint DEFAULT 0 NOT NULL,
  "input_tokens" bigint DEFAULT 0 NOT NULL,
  "output_tokens" bigint DEFAULT 0 NOT NULL,
  "last_used_at" timestamptz NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "telemetry_usage_totals_identity_pk" PRIMARY KEY ("tenant_id", "identity_type", "entity_id"),
  CONSTRAINT "telemetry_usage_totals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade,
  CONSTRAINT "telemetry_usage_totals_identity_type_check" CHECK ("identity_type" IN ('account', 'api_key'))
);
--> statement-breakpoint
CREATE TABLE "telemetry_payloads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "request_id" uuid,
  "captured_at" timestamptz DEFAULT now() NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "request_body" jsonb,
  CONSTRAINT "telemetry_payloads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_hash_idx" ON "api_keys" USING btree ("key_hash");
--> statement-breakpoint
CREATE INDEX "api_keys_tenant_id_idx" ON "api_keys" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX "api_keys_parent_key_id_idx" ON "api_keys" USING btree ("parent_key_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_active_shared_ip_uidx" ON "api_keys" USING btree ("issued_client_ip_key") WHERE "parent_key_id" IS NOT NULL AND "revoked_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "models_provider_model_route_uidx" ON "models" USING btree ("provider_id", "model_id", "endpoint_path");
--> statement-breakpoint
CREATE INDEX "models_provider_enabled_idx" ON "models" USING btree ("provider_id", "enabled");
--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_disabled_models_tenant_provider_model_uidx" ON "tenant_disabled_models" USING btree ("tenant_id", "provider_id", "model_id", "endpoint_path");
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_accounts_identity_uidx" ON "provider_accounts" USING btree ("provider_id", (coalesce("tenant_id", '00000000-0000-0000-0000-000000000000'::uuid)), "credential_fingerprint");
--> statement-breakpoint
CREATE INDEX "provider_accounts_status_cooldown_idx" ON "provider_accounts" USING btree ("status", "cooldown_until");
--> statement-breakpoint
CREATE INDEX "provider_accounts_provider_tenant_idx" ON "provider_accounts" USING btree ("provider_id", "tenant_id");
--> statement-breakpoint
CREATE INDEX "network_pools_tenant_id_idx" ON "network_pools" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX "network_pools_status_cooldown_idx" ON "network_pools" USING btree ("status", "cooldown_until");
--> statement-breakpoint
CREATE INDEX "health_events_account_id_created_at_idx" ON "health_events" USING btree ("account_id", "created_at");
--> statement-breakpoint
CREATE INDEX "health_events_network_pool_id_created_at_idx" ON "health_events" USING btree ("network_pool_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "model_aliases_tenant_alias_uidx" ON "model_aliases" USING btree ("tenant_id", "alias");
--> statement-breakpoint
CREATE UNIQUE INDEX "model_combos_tenant_name_uidx" ON "model_combos" USING btree ("tenant_id", "name");
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_routing_settings_tenant_provider_idx" ON "provider_routing_settings" USING btree ("tenant_id", "provider_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_routing_settings_global_provider_idx" ON "provider_routing_settings" USING btree ("provider_id") WHERE tenant_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_console_lockouts_ip" ON "console_lockouts" USING btree ("ip");
--> statement-breakpoint
CREATE INDEX "idx_console_sessions_user_id" ON "console_sessions" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "idx_console_users_tenant_id" ON "console_users" USING btree ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_console_users_username" ON "console_users" USING btree ("username");
--> statement-breakpoint
CREATE UNIQUE INDEX "cli_tool_mappings_key" ON "cli_tool_mappings" USING btree ("tenant_id", "tool_id", "slot_key");
--> statement-breakpoint
CREATE INDEX "admin_audit_log_tenant_id_created_at_id_idx" ON "admin_audit_log" USING btree ("tenant_id", "created_at", "id");
--> statement-breakpoint
CREATE INDEX "idx_telemetry_created_at" ON "telemetry_events" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "telemetry_events_tenant_created_idx" ON "telemetry_events" USING btree ("tenant_id", "created_at");
--> statement-breakpoint
CREATE INDEX "telemetry_events_request_id_idx" ON "telemetry_events" USING btree ("request_id");
--> statement-breakpoint
CREATE INDEX "telemetry_events_api_key_created_idx" ON "telemetry_events" USING btree ("api_key_id", "created_at");
--> statement-breakpoint
CREATE INDEX "telemetry_events_tenant_account_created_idx" ON "telemetry_events" USING btree ("tenant_id", "account_id", "created_at");
--> statement-breakpoint
CREATE INDEX "telemetry_payloads_request_id_idx" ON "telemetry_payloads" USING btree ("request_id");
--> statement-breakpoint
CREATE INDEX "telemetry_payloads_tenant_request_idx" ON "telemetry_payloads" USING btree ("tenant_id", "request_id");
--> statement-breakpoint
CREATE INDEX "telemetry_payloads_expires_idx" ON "telemetry_payloads" USING btree ("expires_at");
--> statement-breakpoint
CREATE TABLE "share_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "api_key_id" uuid NOT NULL REFERENCES "api_keys" ("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "token_encrypted" bytea,
  "kind" text NOT NULL DEFAULT 'enroll',
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz,
  "used_at" timestamptz,
  "last_viewed_at" timestamptz,
  CONSTRAINT "share_links_kind_check" CHECK ("kind" IN ('enroll', 'handoff'))
);
--> statement-breakpoint
CREATE TABLE "studio_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "title" text NOT NULL DEFAULT 'New session',
  "model" text NOT NULL DEFAULT '',
  "system_prompt" text NOT NULL DEFAULT '',
  "messages_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "media_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX "studio_sessions_tenant_updated_idx" ON "studio_sessions" ("tenant_id", "updated_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "share_links_token_hash_idx" ON "share_links" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "idx_share_links_api_key" ON "share_links" USING btree ("api_key_id");
--> statement-breakpoint
CREATE INDEX "idx_share_links_active" ON "share_links" USING btree ("active", "kind", "expires_at");
--> statement-breakpoint
