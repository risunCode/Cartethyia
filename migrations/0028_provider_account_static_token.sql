-- A pasted bearer token (a JWT/access token on its own, or a JSON export with
-- no refresh token) is a *static* credential: it is used exactly as issued and
-- cannot be re-minted. Before this, such an account was stamped
-- `oauth_reauth_required` and shown as "Re-login required" — which reads as a
-- broken account even though the token is still valid and dispatchable — and a
-- refreshable account whose refresh grant died was disabled outright although
-- its access token still worked.
--
-- `static_token` states the fact directly, orthogonal to `credential_kind`: an
-- `oauth` account can carry a static token. A static account is skipped by the
-- proactive refresh sweep and is never disabled by a refresh failure.
ALTER TABLE "provider_accounts"
  ADD COLUMN IF NOT EXISTS "static_token" boolean DEFAULT false NOT NULL;

-- Existing accounts whose OAuth state carries no refresh token are exactly the
-- static-token case the flag describes; mark them so their status reads as an
-- informational "static token" rather than a re-auth requirement. Re-running is
-- a no-op because the flag is already set.
UPDATE "provider_accounts" a
SET "static_token" = true
WHERE a."credential_kind" = 'oauth'
  AND EXISTS (
    SELECT 1 FROM "provider_oauth_states" s
    WHERE s."provider_account_id" = a."id"
      AND s."refresh_ciphertext" IS NULL
  );

-- The `oauth_reauth_required` category is retired: a static token is a normal,
-- usable credential, not an error state, and the flag now carries the fact.
-- Clear the stale stamp so such accounts stop presenting as broken.
UPDATE "provider_accounts"
SET "last_error" = NULL,
    "last_error_category" = NULL,
    "last_error_at" = NULL
WHERE "static_token" = true
  AND "last_error_category" = 'oauth_reauth_required';
