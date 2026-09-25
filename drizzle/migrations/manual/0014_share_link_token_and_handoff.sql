-- Share links gain a re-displayable token and a personal handoff kind.
--
-- Why the token column: the console must show a stable link for a key instead
-- of losing it after the single response that minted it. The hash stays the
-- lookup key; the token is retained encrypted for the owner's console only, so
-- a leaked database still does not yield a usable bearer without the
-- credential-encryption key.
--
-- Why the new kind: a personal key needs the same stable handoff link, but it
-- must not become an enrollment template — enrollment issues child keys, a
-- handoff reveals the key itself. The old check constraint allowed only
-- 'enroll'.
--
-- Rows written before this migration keep NULL token_encrypted and simply
-- cannot be shown again, which is the honest outcome for a token that was
-- never retained.
--
-- Idempotent: safe to run more than once.
ALTER TABLE share_links ADD COLUMN IF NOT EXISTS token_encrypted bytea;

ALTER TABLE share_links DROP CONSTRAINT IF EXISTS share_links_kind_check;
DO $migration$
BEGIN
  ALTER TABLE share_links
    ADD CONSTRAINT share_links_kind_check CHECK (kind IN ('enroll', 'handoff'));
EXCEPTION WHEN duplicate_object THEN
  NULL;
END
$migration$;
