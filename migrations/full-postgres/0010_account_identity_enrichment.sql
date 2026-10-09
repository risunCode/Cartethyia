-- Account identity enrichment columns.
--
-- `identity_checked_at` is the convergence stamp that makes a batch import
-- instant: the batch persists the credential without parsing it, and the
-- enrichment sweep reads the identity afterwards. An account is only listed
-- while this is null, so a completed pass never re-decrypts a credential it
-- already read.
--
-- `account_email` holds the email read out of the account's own JWT claims.
-- Cosmetic only — it names the account in the console and is never used to
-- authenticate or route. Existing rows start unenriched and are picked up by
-- the next sweep pass.
ALTER TABLE "provider_accounts" ADD COLUMN IF NOT EXISTS "identity_checked_at" timestamptz;
ALTER TABLE "provider_accounts" ADD COLUMN IF NOT EXISTS "account_email" text;
