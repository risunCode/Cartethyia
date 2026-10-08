-- Materialize the implicit `search:invoke` grant before revocation becomes possible.
--
-- `createAccessDecision` used to append `search:invoke` to any key holding
-- `routing:invoke`, so an operator unchecking the scope saved `["routing:invoke"]`
-- and got search back on the next read — there was no way to express "routing
-- without search". The backfill is being removed so the toggle means what it says,
-- which would otherwise silently strip search from every existing key that never
-- spelled the scope out.
--
-- This writes the grant explicitly onto exactly the keys the backfill was
-- supplying it to: rows that hold `routing:invoke` and lack `search:invoke`.
-- Keys that never held `routing:invoke` are untouched — they never received the
-- implicit grant and must not gain one.
UPDATE "api_keys"
SET "scopes" = (
  SELECT jsonb_agg(entry)
  FROM (
    SELECT DISTINCT value AS entry
    FROM jsonb_array_elements_text("scopes") AS value
    UNION
    SELECT 'search:invoke'
  ) AS merged
)
WHERE "scopes" ? 'routing:invoke'
  AND NOT ("scopes" ? 'search:invoke');
