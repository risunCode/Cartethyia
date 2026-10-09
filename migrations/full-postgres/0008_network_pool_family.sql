-- Adds the operator-set family tag to network_pools.
--
-- Purely organisational: it names which family a node belongs to (e.g.
-- `residential-id`, `datacenter-sg`) so the proxy list can show it. Nothing in
-- routing or dispatch reads it, and existing rows simply start untagged.
ALTER TABLE "network_pools" ADD COLUMN IF NOT EXISTS "family" text;
CREATE INDEX IF NOT EXISTS "network_pools_family_idx" ON "network_pools" ("family");

-- Cline's transport cannot route through a plain HTTP/S CONNECT proxy, so it
-- joins InferHub in the skip-proxy default set (DEFAULT_PROXY_SKIP_PROVIDER_IDS
-- in src/providers/metadata.ts). An existing install that never configured
-- Cline's routing already holds a row pinned to the old default; clear that
-- stale choice so the manifest default takes effect. A tenant that deliberately
-- opted into proxying Cline has an explicitly written row, and this backfill
-- runs once, at migration time, so it cannot undo that later choice.
UPDATE "provider_routing_settings"
   SET "skip_proxy" = true
 WHERE "provider_id" = 'cline';
