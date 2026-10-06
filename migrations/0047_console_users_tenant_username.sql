-- Usernames were unique across every tenant, so two deployments restored into
-- one database could not both keep an `admin`. Uniqueness is now per tenant.
-- Existing rows already satisfy the wider constraint, so nothing is rewritten.
DROP INDEX IF EXISTS "idx_console_users_username";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "console_users_tenant_username_uidx"
  ON "console_users" ("tenant_id", "username");
