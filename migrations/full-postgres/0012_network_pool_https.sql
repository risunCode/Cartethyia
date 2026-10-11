-- Network pool transports: `https` becomes storable, `bridge` is retired.
--
-- `https` was already a runtime transport — `TRANSPORT_KINDS` in
-- src/network/pool/agent.ts has carried it beside `http` and `socks5` — but the
-- persisted enum never had it, so a pool could not be *saved* as one. That gap
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
-- Postgres cannot drop an enum value, so the type is recreated. The fold happens
-- in the `USING` clause rather than in an UPDATE before it: until the column has
-- the new type, assigning the literal `'https'` is typed against the *old* enum,
-- which does not contain it, and the statement is rejected outright.
ALTER TYPE "network_pool_kind" RENAME TO "network_pool_kind_retired";

--> statement-breakpoint
CREATE TYPE "network_pool_kind" AS ENUM ('http', 'https', 'socks5');

--> statement-breakpoint
ALTER TABLE "network_pools"
  ALTER COLUMN "kind" TYPE "network_pool_kind"
  USING (
    CASE WHEN "kind"::text = 'bridge' THEN 'https' ELSE "kind"::text END
  )::"network_pool_kind";

--> statement-breakpoint
DROP TYPE "network_pool_kind_retired";
