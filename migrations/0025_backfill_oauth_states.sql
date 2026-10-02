-- Backfill a `provider_oauth_states` row for every OAuth account that has none.
--
-- Accounts pasted through the console before this change never got a state row
-- (only the OAuth login flow and the MiMo importers wrote one), so the
-- proactive refresh sweep — which inner-joins this table — skipped them
-- entirely and their tokens expired with no operator signal. A row with a null
-- refresh token and null expiry makes them visible: the sweep lists them as
-- "always due", finds no refresh token, and flags them for re-authentication
-- instead of leaving them silently broken.
DO $$
BEGIN
  INSERT INTO "provider_oauth_states" ("provider_account_id", "refresh_ciphertext", "expires_at")
  SELECT a."id", NULL, NULL
  FROM "provider_accounts" a
  WHERE a."credential_kind" = 'oauth'
    AND NOT EXISTS (
      SELECT 1 FROM "provider_oauth_states" s
      WHERE s."provider_account_id" = a."id"
    );
END $$;
