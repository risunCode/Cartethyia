-- One convention: <table>_<columns>_idx. The idx_ prefix predated it.
ALTER INDEX IF EXISTS "idx_share_links_api_key" RENAME TO "share_links_api_key_idx";
--> statement-breakpoint
ALTER INDEX IF EXISTS "idx_share_links_active" RENAME TO "share_links_active_kind_expires_idx";
--> statement-breakpoint
ALTER INDEX IF EXISTS "idx_console_users_tenant_id" RENAME TO "console_users_tenant_id_idx";
--> statement-breakpoint
ALTER INDEX IF EXISTS "idx_console_sessions_user_id" RENAME TO "console_sessions_user_id_idx";
--> statement-breakpoint
ALTER INDEX IF EXISTS "idx_telemetry_created_at" RENAME TO "telemetry_events_created_at_idx";
