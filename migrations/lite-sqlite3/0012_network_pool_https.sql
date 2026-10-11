-- Network pool transports: `https` becomes storable, `bridge` is retired.
--
-- `https` was already a runtime transport — `TRANSPORT_KINDS` in
-- src/network/pool/agent.ts has carried it beside `http` and `socks5` — but the
-- persisted CHECK never had it, so a pool could not be *saved* as one. That gap
-- matters for imported configurations: a hosted relay (Vercel, Cloudflare, Deno,
-- Netlify) is an HTTPS front door, and the only kinds the column accepted were
-- `http`, `socks5`, and `bridge`. An operator had to record an HTTPS front door
-- as `bridge` — an application relay with its own header contract — or as plain
-- `http`, which understates the protocol the pool actually speaks.
--
-- `bridge` goes the other way: carte-bridge is deprecated, and this install holds
-- zero rows of that kind (counted against the live `network_pools` table), so the
-- value is retired rather than migrated. A `bridge` row that exists anyway — an
-- install that made one after that count — folds to `https`, which is what its
-- own endpoint validator already assumed: `normalizeBridgeEndpoint` read a bare
-- host as https because "every hosted bridge terminates TLS".
--
-- SQLite cannot alter a CHECK in place, so the table is rebuilt. The order below
-- is not cosmetic; it is what makes the rebuild lossless, and both halves were
-- measured against a scratch database rather than reasoned about:
--
-- 1. `ALTER TABLE … RENAME TO` rewrites the REFERENCES clauses of every table
--    pointing at the renamed one, so after renaming `network_pools` the
--    `health_events` foreign key names the *retired* table.
-- 2. `DROP TABLE` on a parent with `foreign_keys = ON` performs an implicit
--    DELETE, and `health_events.network_pool_id` is `ON DELETE CASCADE` — so
--    dropping the retired table while that key still points at it silently
--    deletes every health event for every pool. Measured: one row before the
--    drop, zero after.
--
-- So `health_events` is rebuilt first, pointing at the new table under its
-- temporary name, which removes it from the path of the drop; the pools table is
-- then swapped with nothing referencing the retired name; and the final rename
-- rewrites that key back to `network_pools`. The pragma cannot simply be turned
-- off around this, because `PRAGMA foreign_keys` is a no-op inside a
-- transaction and the runner applies each file in one.
ALTER TABLE "network_pools" RENAME TO "network_pools_retired_kind";

--> statement-breakpoint
CREATE TABLE "network_pools_rebuilt" (
  "id" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "created_at" text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
  "endpoint_config" text NOT NULL,
  "credential_ciphertext" blob,
  "max_inflight" integer,
  "weight" integer,
  "tenant_id" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "consecutive_failures" integer DEFAULT 0 NOT NULL,
  "last_success_at" text,
  "last_latency_ms" integer,
  "last_error" text,
  "last_error_category" text,
  "cooldown_until" text,
  "last_recovered_at" text,
  "model_cooldowns" text DEFAULT '{}' NOT NULL,
  "sort_index" integer DEFAULT 0 NOT NULL,
  "family" text,
  CONSTRAINT "network_pools_kind_enum_check" CHECK ("kind" IS NULL OR "kind" IN ('http', 'https', 'socks5')),
  CONSTRAINT "network_pools_status_enum_check" CHECK ("status" IS NULL OR "status" IN ('active', 'cooldown', 'disabled')),
  CONSTRAINT "network_pools_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade
);

--> statement-breakpoint
INSERT INTO "network_pools_rebuilt" (
  "id", "kind", "created_at", "endpoint_config", "credential_ciphertext",
  "max_inflight", "weight", "tenant_id", "status", "consecutive_failures",
  "last_success_at", "last_latency_ms", "last_error", "last_error_category",
  "cooldown_until", "last_recovered_at", "model_cooldowns", "sort_index", "family"
)
SELECT
  "id",
  CASE WHEN "kind" = 'bridge' THEN 'https' ELSE "kind" END,
  "created_at", "endpoint_config", "credential_ciphertext",
  "max_inflight", "weight", "tenant_id", "status", "consecutive_failures",
  "last_success_at", "last_latency_ms", "last_error", "last_error_category",
  "cooldown_until", "last_recovered_at", "model_cooldowns", "sort_index", "family"
FROM "network_pools_retired_kind";

--> statement-breakpoint
-- Step 1 of the swap: move the only table that references the pools out of the
-- drop's path. Its foreign key now names `network_pools_retired_kind`, so it is
-- rebuilt against `network_pools_rebuilt` — the final rename repairs the name.
ALTER TABLE "health_events" RENAME TO "health_events_retired_kind";

--> statement-breakpoint
CREATE TABLE "health_events" (
  "id" text PRIMARY KEY NOT NULL,
  "entity_kind" text NOT NULL,
  "account_id" text,
  "network_pool_id" text,
  "from_status" text,
  "to_status" text NOT NULL,
  "reason" text,
  "error_category" text,
  "model_id" text,
  "created_at" text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
  CONSTRAINT "health_events_account_id_provider_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "provider_accounts"("id") ON DELETE cascade,
  CONSTRAINT "health_events_network_pool_id_network_pools_rebuilt_id_fk" FOREIGN KEY ("network_pool_id") REFERENCES "network_pools_rebuilt"("id") ON DELETE cascade,
  CONSTRAINT "health_events_entity_kind_enum_check" CHECK ("entity_kind" IS NULL OR "entity_kind" IN ('account', 'pool')),
  CONSTRAINT "health_events_from_status_enum_check" CHECK ("from_status" IS NULL OR "from_status" IN ('active', 'cooldown', 'disabled')),
  CONSTRAINT "health_events_to_status_enum_check" CHECK ("to_status" IS NULL OR "to_status" IN ('active', 'cooldown', 'disabled')),
  CONSTRAINT "health_events_entity_reference_check" CHECK (("entity_kind" = 'account' AND "account_id" IS NOT NULL AND "network_pool_id" IS NULL) OR ("entity_kind" = 'pool' AND "network_pool_id" IS NOT NULL AND "account_id" IS NULL))
);

--> statement-breakpoint
INSERT INTO "health_events" (
  "id", "entity_kind", "account_id", "network_pool_id", "from_status", "to_status",
  "reason", "error_category", "model_id", "created_at"
)
SELECT
  "id", "entity_kind", "account_id", "network_pool_id", "from_status", "to_status",
  "reason", "error_category", "model_id", "created_at"
FROM "health_events_retired_kind";

--> statement-breakpoint
DROP TABLE "health_events_retired_kind";

--> statement-breakpoint
-- Step 2: nothing references the retired pools table now, so this drop cannot
-- cascade into anything.
DROP TABLE "network_pools_retired_kind";

--> statement-breakpoint
-- Step 3: the rename rewrites the health_events key back to `network_pools`.
ALTER TABLE "network_pools_rebuilt" RENAME TO "network_pools";

--> statement-breakpoint
-- The old tables' indexes went with them, so they are recreated here rather than
-- left for the additive schema sync to guess at.
CREATE INDEX IF NOT EXISTS "network_pools_family_idx" ON "network_pools" ("family");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "network_pools_tenant_id_idx" ON "network_pools" ("tenant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "network_pools_status_cooldown_idx" ON "network_pools" ("status", "cooldown_until");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "health_events_account_id_created_at_idx" ON "health_events" ("account_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "health_events_account_model_created_idx" ON "health_events" ("account_id", "model_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "health_events_network_pool_id_created_at_idx" ON "health_events" ("network_pool_id", "created_at");
