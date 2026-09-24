-- Normalizes legacy quota-alias provider ids to their canonical ids.
--
-- The alias map (`PROVIDER_ALIASES`, derived from `quotaAliases`) was removed
-- with no backward-compat fallback by design. Rows written before that change
-- can still carry an alias as their provider id, so dispatch, quota, and
-- routing would lose those providers until this runs:
--
--   * `kimi-code`   -> `kimi`
--   * `zaicp`       -> `zai`
--   * `ollama`      -> `ollamacloud`
--   * `ollama-cloud`-> `ollamacloud`
--
-- Order matters. `provider_accounts.provider_id`, `models.provider_id`,
-- `tenant_disabled_models.provider_id`, and
-- `provider_routing_settings.provider_id` are FKs to `providers.id` with
-- `ON DELETE cascade` (and no `ON UPDATE cascade`), so the canonical parent
-- row must exist before children are re-pointed and must not be dropped while
-- children still reference it.
--
-- Unlike the `grok-cli` rename, these aliases never had a parent row of their
-- own in every database: an alias may appear only in child tables (a provider
-- registered as `ollama` but seeded as `ollamacloud`). Each block therefore
-- creates the canonical parent from the alias row only if it is missing,
-- re-points children, then deletes a leftover alias parent if one exists.
--
-- `telemetry_events.provider_id` is a plain correlation column (no FK), so it
-- is normalized in place and left as-is if no canonical row can be derived.
--
-- Safe to re-run: every statement is guarded or idempotent.
--
--   bun run db:migrate   # no-op for manual files; safe to run first
--   # then paste this file into psql, or run each statement below.

-- 1. Ensure the canonical parent row exists, copying the alias row's config.
INSERT INTO "providers" (
  "id", "tenant_id", "wire_family_default", "capability_profile",
  "base_url", "compatibility_profile", "enabled", "requires_account"
)
SELECT
  v.canonical, p."tenant_id", p."wire_family_default", p."capability_profile",
  p."base_url", p."compatibility_profile", p."enabled", p."requires_account"
FROM "providers" p
JOIN (VALUES
  ('kimi-code', 'kimi'),
  ('zaicp', 'zai'),
  ('ollama', 'ollamacloud'),
  ('ollama-cloud', 'ollamacloud')
) AS v(alias, canonical) ON p."id" = v.alias
WHERE NOT EXISTS (SELECT 1 FROM "providers" c WHERE c."id" = v.canonical);

-- 2. Re-point every child row at the canonical id. `ollamacloud` has two
--    aliases, so both are folded onto the same id.
UPDATE "provider_accounts" AS t
   SET "provider_id" = v.canonical
  FROM (VALUES
    ('kimi-code', 'kimi'),
    ('zaicp', 'zai'),
    ('ollama', 'ollamacloud'),
    ('ollama-cloud', 'ollamacloud')
  ) AS v(alias, canonical)
 WHERE t."provider_id" = v.alias;

UPDATE "models" AS t
   SET "provider_id" = v.canonical
  FROM (VALUES
    ('kimi-code', 'kimi'),
    ('zaicp', 'zai'),
    ('ollama', 'ollamacloud'),
    ('ollama-cloud', 'ollamacloud')
  ) AS v(alias, canonical)
 WHERE t."provider_id" = v.alias;

UPDATE "tenant_disabled_models" AS t
   SET "provider_id" = v.canonical
  FROM (VALUES
    ('kimi-code', 'kimi'),
    ('zaicp', 'zai'),
    ('ollama', 'ollamacloud'),
    ('ollama-cloud', 'ollamacloud')
  ) AS v(alias, canonical)
 WHERE t."provider_id" = v.alias;

-- Provider-keyed routing configuration written by the console. A row that
-- would collide with an existing canonical row (same tenant + provider) is
-- dropped: the canonical row is authoritative and wins, and the update would
-- otherwise violate the unique index.
DELETE FROM "provider_routing_settings" AS t
 USING (VALUES
   ('kimi-code', 'kimi'),
   ('zaicp', 'zai'),
   ('ollama', 'ollamacloud'),
   ('ollama-cloud', 'ollamacloud')
 ) AS v(alias, canonical)
 WHERE t."provider_id" = v.alias
   AND EXISTS (
     SELECT 1 FROM "provider_routing_settings" c
      WHERE c."provider_id" = v.canonical
        AND c."tenant_id" IS NOT DISTINCT FROM t."tenant_id"
   );

UPDATE "provider_routing_settings" AS t
   SET "provider_id" = v.canonical
  FROM (VALUES
    ('kimi-code', 'kimi'),
    ('zaicp', 'zai'),
    ('ollama', 'ollamacloud'),
    ('ollama-cloud', 'ollamacloud')
  ) AS v(alias, canonical)
 WHERE t."provider_id" = v.alias;

-- 3. Correlation-only telemetry rows.
UPDATE "telemetry_events" AS t
   SET "provider_id" = v.canonical
  FROM (VALUES
    ('kimi-code', 'kimi'),
    ('zaicp', 'zai'),
    ('ollama', 'ollamacloud'),
    ('ollama-cloud', 'ollamacloud')
  ) AS v(alias, canonical)
 WHERE t."provider_id" = v.alias;

-- 4. Drop the alias parent rows now that nothing references them. Guarded so a
--    re-run (or a database that never used the aliases) is a no-op.
DELETE FROM "providers" AS p
 USING (VALUES
   ('kimi-code', 'kimi'),
   ('zaicp', 'zai'),
   ('ollama', 'ollamacloud'),
   ('ollama-cloud', 'ollamacloud')
 ) AS v(alias, canonical)
 WHERE p."id" = v.alias
   AND EXISTS (SELECT 1 FROM "providers" c WHERE c."id" = v.canonical);
