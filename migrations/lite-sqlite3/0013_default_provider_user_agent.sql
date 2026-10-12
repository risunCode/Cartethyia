-- Route identity: a provider with no operator-chosen User-Agent now defaults
-- to the Claude Code CLI identity instead of the Codex CLI identity.
--
-- The rationale is in the PostgreSQL twin (`0013_default_provider_user_agent.sql`);
-- this file differs only in the SQLite spelling. SQLite cannot ALTER a column
-- default, so the table is rebuilt. The rebuild restates the baseline definition
-- exactly — both foreign keys, the strategy CHECK, and the two boolean CHECKs —
-- because a dropped table takes them with it and the additive schema sync
-- would not restore a constraint it has no record of. The only value that
-- changes is `user_agent`, and only where it holds the retired frozen default,
-- which the SELECT states explicitly rather than leaving to the copy.
--
-- A row holding exactly `codex_cli_rs/0.156.1` cannot be distinguished from an
-- operator who deliberately picked Codex: it is simultaneously the default this
-- migration retires and a value someone could have chosen. Every other stored
-- identity is left as-is.
--
-- Nothing references this table, so the implicit DELETE the drop performs under
-- `foreign_keys = ON` has no dependents to take. `PRAGMA foreign_keys` is a
-- no-op inside a transaction and the runner applies each file in one, so the
-- drop cannot be bracketed by a pragma toggle — the constraint `0012` documents.
CREATE TABLE "provider_routing_settings_rebuilt" (
  "provider_id" text NOT NULL,
  "tenant_id" text,
  "strategy" text DEFAULT 'fallback' NOT NULL,
  "rotate_count" integer DEFAULT 1 NOT NULL,
  "max_inflight" integer,
  "usage_floor" integer,
  "usage_floor_unit" text DEFAULT 'percent' NOT NULL,
  "enabled" integer DEFAULT false NOT NULL CHECK ("enabled" IN (0, 1)),
  "user_agent" text DEFAULT 'claude-cli/2.1.293 (external, cli)' NOT NULL,
  "skip_proxy" integer DEFAULT false NOT NULL CHECK ("skip_proxy" IN (0, 1)),
  CONSTRAINT "provider_routing_settings_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "providers" ("id") ON DELETE cascade,
  CONSTRAINT "provider_routing_settings_strategy_enum_check" CHECK ("strategy" IS NULL OR "strategy" IN ('fallback', 'round_robin')),
  CONSTRAINT "provider_routing_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE cascade
);

--> statement-breakpoint
INSERT INTO "provider_routing_settings_rebuilt" (
  "provider_id", "tenant_id", "strategy", "rotate_count", "max_inflight",
  "usage_floor", "usage_floor_unit", "enabled", "user_agent", "skip_proxy"
)
SELECT
  "provider_id", "tenant_id", "strategy", "rotate_count", "max_inflight",
  "usage_floor", "usage_floor_unit", "enabled",
  CASE WHEN "user_agent" = 'codex_cli_rs/0.156.1'
    THEN 'claude-cli/2.1.293 (external, cli)'
    ELSE "user_agent" END,
  "skip_proxy"
FROM "provider_routing_settings";

--> statement-breakpoint
DROP TABLE "provider_routing_settings";

--> statement-breakpoint
ALTER TABLE "provider_routing_settings_rebuilt" RENAME TO "provider_routing_settings";

--> statement-breakpoint
-- The two unique indexes lived on the retired table and went with it. They are
-- recreated under the names the baseline establishes: the per-tenant pair and
-- the partial global one (which is what keeps a second global row per provider
-- out of the table).
CREATE UNIQUE INDEX IF NOT EXISTS "provider_routing_settings_tenant_provider_idx"
  ON "provider_routing_settings" ("tenant_id", "provider_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "provider_routing_settings_global_provider_idx"
  ON "provider_routing_settings" ("provider_id") WHERE tenant_id IS NULL;