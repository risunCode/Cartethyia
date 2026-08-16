-- ============================================================================
-- 0001_initial.down.sql — reverse the initial schema.
-- ============================================================================

DROP TABLE IF EXISTS share_links    CASCADE;
DROP TABLE IF EXISTS quota_accounts CASCADE;
DROP TABLE IF EXISTS api_keys       CASCADE;
DROP TABLE IF EXISTS user_settings  CASCADE;
DROP TABLE IF EXISTS users          CASCADE;
