-- The console Studio playground is retired; its page is now a coming-soon
-- placeholder. Saved playground sessions were the only data it owned, and
-- nothing outside the domain read them, so the table and its index go with it.
DROP INDEX IF EXISTS "studio_sessions_tenant_updated_idx";
--> statement-breakpoint
DROP TABLE IF EXISTS "studio_sessions";
