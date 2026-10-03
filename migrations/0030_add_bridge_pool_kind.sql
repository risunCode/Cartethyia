-- Add the `bridge` network-pool kind.
--
-- A `bridge` pool is a carte-bridge instance (Railway/Vercel/Netlify/Deno/Docker)
-- dialed as an application relay rather than an RFC CONNECT proxy. It is a
-- distinct kind instead of an `endpoint_config` flag so the transport's
-- `switch (kind)` exhaustiveness check forces every dispatch path — resolver,
-- health check, speed test, console validation, dashboard dropdown — to handle
-- it, and so the stored row is honest about how traffic actually leaves.
--
-- Additive label only: no existing row changes value, so unlike the `degraded`
-- retirement (0002) this needs no rebuild of the type and no data fold. Every
-- current row stays a valid member of the extended set.
--
-- Idempotent: `ADD VALUE IF NOT EXISTS` is a no-op when the value is already
-- present (e.g. a fresh install that ran the updated baseline). The `DO` block
-- guards the type's existence so a database without the enum (not possible
-- here, but safe) does not error. The runner applies each file in its own
-- transaction; on PostgreSQL 12+ `ALTER TYPE ... ADD VALUE` inside a
-- transaction is allowed and takes effect at commit, and no later statement in
-- this file uses the new label, so there is no "unsafe use of new value" risk.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'network_pool_kind') THEN
    ALTER TYPE "public"."network_pool_kind" ADD VALUE IF NOT EXISTS 'bridge';
  END IF;
END $$;
