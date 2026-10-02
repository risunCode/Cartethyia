-- OAuth accounts pasted as an access token (or a JSON export with no refresh
-- token) had no way to be tracked: `provider_oauth_states` required both a
-- refresh token and an expiry, so such an account got no state row at all and
-- the proactive refresh sweep — which inner-joins that table — never saw it.
-- The token then died silently at first expiry.
--
-- Both columns become nullable so an account can carry a state row with an
-- unknown refresh token and an unknown expiry. A null expiry reads as
-- "always due" (refresh as soon as possible); a null refresh token means the
-- account cannot be refreshed and is flagged for re-authentication.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'provider_oauth_states'
      AND column_name = 'refresh_ciphertext'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "provider_oauth_states" ALTER COLUMN "refresh_ciphertext" DROP NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'provider_oauth_states'
      AND column_name = 'expires_at'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "provider_oauth_states" ALTER COLUMN "expires_at" DROP NOT NULL;
  END IF;
END $$;
