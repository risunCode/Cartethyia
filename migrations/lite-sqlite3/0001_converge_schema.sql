-- SQLite twin of migrations/full-postgres/0001_converge_schema.sql.
--
-- A fresh SQLite database runs 0000_baseline.sql and finds every step here a
-- no-op. The PostgreSQL file rebuilds enum types and folds rows out of retired
-- columns; SQLite has no enum type and no database old enough to hold those
-- columns, so only the shape the current schema still has is restated here,
-- in the dialect the generator uses (boolean → integer, jsonb → text,
-- timestamptz → text, bytea → blob).
ALTER TABLE "provider_routing_settings" ADD COLUMN "user_agent" text NOT NULL DEFAULT 'codex_cli_rs/0.156.1';
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "client_router_denylist" text;
--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD COLUMN "auth_state" text;
--> statement-breakpoint
ALTER TABLE "provider_oauth_states" ADD COLUMN "client_secret_ciphertext" blob;
--> statement-breakpoint
ALTER TABLE "health_events" ADD COLUMN "model_id" text;
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "sort_index" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "model_combos" ADD COLUMN "sort_index" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "model_aliases" ADD COLUMN "sort_index" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "network_pools" ADD COLUMN "egress_ip" text;
--> statement-breakpoint
ALTER TABLE "network_pools" ADD COLUMN "quota_bytes" integer;
--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD COLUMN "sort_index" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "service_kind" text NOT NULL DEFAULT 'llm';
--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD COLUMN "static_token" integer NOT NULL DEFAULT 0 CHECK ("static_token" IN (0, 1));
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "enabled" integer NOT NULL DEFAULT 1 CHECK ("enabled" IN (0, 1));
--> statement-breakpoint
ALTER TABLE "network_pools" ADD COLUMN "last_speedtest_bytes" integer;
--> statement-breakpoint
ALTER TABLE "network_pools" ADD COLUMN "last_speedtest_duration_ms" integer;
--> statement-breakpoint
ALTER TABLE "network_pools" ADD COLUMN "last_speedtest_status" text;
--> statement-breakpoint
ALTER TABLE "network_pools" ADD COLUMN "last_speedtest_error" text;
--> statement-breakpoint
ALTER TABLE "network_pools" ADD COLUMN "last_speedtest_at" text;
--> statement-breakpoint
ALTER TABLE "network_pools" ADD COLUMN "bytes_sent_total" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "network_pools" ADD COLUMN "bytes_received_total" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "updated_at" text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'));
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "model_access_mode" text NOT NULL DEFAULT 'whitelist';
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "model_list" text;
