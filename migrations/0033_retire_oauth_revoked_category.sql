-- Retire the `oauth_revoked` account error category.
--
-- It named a refresh-grant failure, but the console renders "Re-login required"
-- from `auth_invalidated`, and the quota sweep excludes only that category from
-- its passes. Two spellings of one state meant a revoked refresh grant was
-- re-probed forever while its row showed a raw category string instead of the
-- operator-facing pill. `auth_invalidated` is now the single spelling.
--
-- The companion behaviour — an OAuth account whose stored access token is still
-- usable becomes a static token rather than staying disabled — cannot be
-- expressed in SQL (it decodes the token's own `exp`), so it converges in
-- `reconcileStaticTokenAccounts` on the boot path instead.
UPDATE "provider_accounts"
SET "last_error_category" = 'auth_invalidated'
WHERE "last_error_category" = 'oauth_revoked';
